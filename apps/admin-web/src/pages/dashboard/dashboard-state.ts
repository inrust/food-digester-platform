/**
 * FE-03 总览页纯逻辑：快捷命令模型、耗材展示模型、授权分布与告警文案。
 *
 * 事实源：
 * - 命令白名单/高风险：contracts/mqtt/command-catalog.json（CT-04，卡片快捷动作 START/STOP/REBOOT）；
 * - 耗材名称/阈值：contracts/domain/consumables-policy.json（DEC-008 冻结）；
 * - denyReason 枚举：contracts/rest/admin-dashboard-api.json（BE-DASH-01）。
 * 一致性由 test/contract-parity.test.ts 锁定。
 */
import type { AlarmSeverity, CommandActionView, ConsumableSummaryView, DenyReason } from './types.js';

// ---------- 快捷命令（CT-06 dashboard.button.start/stop/reboot → CT-04 命令码） ----------

export const QUICK_COMMANDS = [
  { command: 'START', label: '启动' },
  { command: 'STOP', label: '停止' },
  { command: 'REBOOT', label: '重启' },
] as const;

export const DENY_REASON_LABELS: Readonly<Record<DenyReason, string>> = {
  FORBIDDEN: '无操作权限',
  UNKNOWN_COMMAND: '命令不可用',
  DEVICE_RETIRED: '设备已退役',
  DEVICE_SUSPENDED_RESTRICTED: '设备已停用（受限）',
  DEVICE_MAINTENANCE_RESTRICTED: '设备维护中（受限）',
};

export interface QuickActionModel {
  readonly command: string;
  readonly label: string;
  readonly allowed: boolean;
  readonly denyReason: DenyReason | null;
}

/** 从卡片 actions（服务端状态门 + 权限）解析快捷动作；目录缺失按 UNKNOWN_COMMAND 失败关闭。 */
export function quickActionsOf(actions: readonly CommandActionView[]): QuickActionModel[] {
  return QUICK_COMMANDS.map(({ command, label }) => {
    const found = actions.find((a) => a.command === command);
    if (found === undefined) {
      return { command, label, allowed: false, denyReason: 'UNKNOWN_COMMAND' };
    }
    return { command, label, allowed: found.allowed, denyReason: found.denyReason };
  });
}

// ---------- 耗材（DEC-008：仅设备上报值；unknown 不伪造百分比；阈值冻结） ----------

export const CONSUMABLE_NAMES: Readonly<Record<ConsumableSummaryView['consumableType'], string>> = {
  CARBON_FILTER: '碳滤网',
  BIO_ADDITIVE: '生物添加剂',
};

/** DEC-008 冻结告警阈值（%）：低于该值按 warn 展示。 */
export const CONSUMABLE_THRESHOLDS: Readonly<Record<ConsumableSummaryView['consumableType'], number>> = {
  CARBON_FILTER: 20,
  BIO_ADDITIVE: 15,
};

export interface ConsumableDisplayModel {
  readonly consumableType: ConsumableSummaryView['consumableType'];
  readonly name: string;
  readonly percent: number | null;
  readonly stale: boolean;
  readonly low: boolean;
}

/** 固定顺序输出两类耗材；缺失类型按 unknown（percent null）处理。 */
export function consumablesOf(list: readonly ConsumableSummaryView[]): ConsumableDisplayModel[] {
  return (['CARBON_FILTER', 'BIO_ADDITIVE'] as const).map((type) => {
    const found = list.find((c) => c.consumableType === type);
    const percent = found?.remainingPercent ?? null;
    return {
      consumableType: type,
      name: CONSUMABLE_NAMES[type],
      percent,
      stale: found?.stale ?? false,
      low: percent !== null && percent < CONSUMABLE_THRESHOLDS[type],
    };
  });
}

// ---------- 指标文案 ----------

export const ALARM_SEVERITY_LABELS: Readonly<Record<AlarmSeverity, string>> = {
  INFO: '提示',
  WARNING: '警告',
  MAJOR: '严重',
  CRITICAL: '紧急',
};

/** License 轴展示名（与 FE-02 四轴徽标同源取值）。 */
const LICENSE_AXIS_LABELS: Readonly<Record<string, string>> = {
  NoLicense: '无授权',
  Draft: '草稿',
  Issued: '已签发',
  Active: '授权有效',
  ExpiringSoon: '即将到期',
  Renewed: '已续期',
  Expired: '已到期',
  Revoked: '已撤销',
  NONE: '无状态',
};

/** 授权分布：按 key 排序拼接；空分布返回“—”。 */
export function licenseDistributionText(distribution: Readonly<Record<string, number>>): string {
  const entries = Object.entries(distribution).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '—';
  return entries.map(([status, count]) => `${LICENSE_AXIS_LABELS[status] ?? status} ${count}`).join(' · ');
}

/** 连接质量：网络类型 + 信号强度原始值（未冻结强弱阈值，不臆造分级）。 */
export function signalText(networkType: string | null, signalStrength: number | null): string {
  const network = networkType ?? '—';
  const strength = signalStrength === null ? '—' : String(signalStrength);
  return `${network} · 信号 ${strength}`;
}
