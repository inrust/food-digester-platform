/**
 * BE-SET-01 业务设置与字典领域服务（框架无关）。
 *
 * 规则（事实源：AUTH-01 权限矩阵、DOM-03 审计、任务清单 BE-SET-01）：
 * - 封闭 key 集（4 项）：alarm.thresholds / command.confirmation /
 *   dictionary.displayNames / notification.business；未知 key → 404（不可创建/删除）；
 * - 版本控制：PUT 必须携带当前 version，条件更新（key + version）+ 自增；
 *   并发修改 → 409 VERSION_CONFLICT；
 * - 值 Schema（非法配置拒绝 400）：
 *   · alarm.thresholds：{ alarmCode: { warning?, major?, critical? } }——非负数值，
 *     同级内 warning ≤ major ≤ critical；
 *   · command.confirmation：{ ttlSec: 30..3600, maxFutureSec: 0..600 }——DEC-023
 *     近期重新认证窗口参数，不得改写确认方式；
 *     不得携带 highRiskCommands 等重定义固定命令目录的字段（命令高风险属性为协议固定）；
 *   · dictionary.displayNames：{ namespace: { code: 显示名 } }——namespace ∈
 *     command / topicType / notificationType；code 必须属于固定封闭集（22 命令 /
 *     11 Topic type / 13 Notification type），未知 code → 400——固定命令/Topic
 *     不可被删除或重命名，本 API 仅维护已知 code 的显示名；
 *   · notification.business：{ eventTypes, channels }——分别为封闭事件/渠道子集；
 * - 不得经本 API 改写固定协议枚举、Topic 或 AWS 运维配置（无对应 key 与字段）；
 * - 全部写操作经 DOM-03 audited 审计（settings.update，含 before/after）；
 * - 功能边界：不管理 CloudWatch 告警、资源阈值或 Budget。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { BUSINESS_SETTING_KEYS, validateBusinessSettingValue } from '@fdp/contracts/settings/business-settings-v1.js';
import { settingsNotFound, settingsValidationFailed, settingsVersionConflict } from './errors.js';

export interface SettingsDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

/** 封闭 key 集（与契约 SettingKey 枚举一致，契约测试强制）。 */
export const SETTING_KEYS = BUSINESS_SETTING_KEYS;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const SETTING_RUNTIME_EFFECTS: Readonly<
  Record<SettingKey, { readonly status: 'ACTIVE' | 'STORED_ONLY'; readonly consumer: string | null }>
> = {
  'alarm.thresholds': { status: 'ACTIVE', consumer: 'FE-18' },
  'command.confirmation': { status: 'ACTIVE', consumer: 'BE-CMD-01' },
  'dictionary.displayNames': { status: 'STORED_ONLY', consumer: null },
  'notification.business': { status: 'STORED_ONLY', consumer: null },
};

// ---------- 行类型与数据访问 ----------

interface SettingRow {
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface SettingDelegate {
  findMany(args: Record<string, unknown>): Promise<unknown[]>;
  findFirst(args: { where: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function settings(client: DbClient): SettingDelegate {
  return (client as unknown as Record<string, unknown>).businessSetting as SettingDelegate;
}

// ---------- DTO ----------

export interface SettingView {
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
  /** ACTIVE 表示已有唯一运行时消费方；STORED_ONLY 表示仅提供校验、版本和审计存储。 */
  readonly runtimeStatus: 'ACTIVE' | 'STORED_ONLY';
  readonly runtimeConsumer: string | null;
}

function toView(row: SettingRow): SettingView {
  const runtime = SETTING_RUNTIME_EFFECTS[row.key as SettingKey];
  if (!runtime) throw settingsValidationFailed(`unexpected stored setting key: ${row.key}`);
  return {
    key: row.key,
    value: row.value,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    runtimeStatus: runtime.status,
    runtimeConsumer: runtime.consumer,
  };
}

function assertKnownKey(key: string): asserts key is SettingKey {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) throw settingsNotFound();
}

// ---------- 查询 ----------

export async function listSettings(deps: SettingsDeps): Promise<SettingView[]> {
  const rows = (await settings(deps.client).findMany({ orderBy: { key: 'asc' } })) as unknown as SettingRow[];
  return rows.map(toView);
}

export async function getSetting(deps: SettingsDeps, key: string): Promise<SettingView> {
  assertKnownKey(key);
  const row = (await settings(deps.client).findFirst({ where: { key } })) as SettingRow | null;
  if (!row) throw settingsNotFound();
  return toView(row);
}

// ---------- 更新（乐观锁 + 审计） ----------

export async function updateSetting(
  deps: SettingsDeps,
  actor: ActorContext,
  key: string,
  input: { readonly value: unknown; readonly version: unknown },
): Promise<SettingView> {
  assertKnownKey(key);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw settingsValidationFailed('version must be a positive integer');
  }
  const version = input.version as number;
  const issues = validateBusinessSettingValue(key, input.value);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw settingsValidationFailed(`${key}${first.path}: ${first.message}`);
  }
  const now = deps.now?.() ?? new Date();

  const before = (await settings(deps.client).findFirst({ where: { key } })) as SettingRow | null;
  if (!before) throw settingsNotFound();

  return audited<SettingView>(
    deps.client,
    {
      objectType: 'business_setting',
      objectId: key,
      action: 'settings.update',
      reason: `version ${before.version} → ${before.version + 1}`,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: null,
      beforeValue: { value: before.value, version: before.version },
      afterValue: { value: input.value, version: before.version + 1 },
    },
    async (tx) => {
      const { count } = await settings(tx).updateMany({
        where: { key, version },
        data: { value: input.value, version: version + 1, updatedBy: actor.actorId, updatedAt: now },
      });
      if (count !== 1) throw settingsVersionConflict();
      const fresh = (await settings(tx).findFirst({ where: { key } })) as SettingRow;
      return toView(fresh);
    },
  );
}
