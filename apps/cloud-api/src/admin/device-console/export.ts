/**
 * BE-DEV-05 设备活动异步 CSV 导出 Service + Export Worker（框架无关）。
 *
 * 规则（沿用 BE-ESG-02 导出模式）：
 * - 创建导出（export:create = PlatformSuperAdmin/Auditor/CustomerAdmin）：冻结筛选快照
 *   （level/kind/from/to，与列表查询同源——筛选结果与 CSV 一致）+ Customer scope
 *   （Customer 角色强制本 Customer；设备经 loadScopedDevice 隔离，跨 Customer → 404）；
 *   DOM-03 审计 activity.export.create；异步执行（本模块仅入队 PENDING，Worker 处理，
 *   非数据库不限量同步查询）；
 * - Worker（processActivityExportJobs）：PENDING→PROCESSING（条件更新并发兜底）→
 *   fetchAllDeviceActivities 同源查询（分批游标，上限 ACTIVITY_EXPORT_MAX_ROWS）→
 *   CSV（ACTIVITY_CSV_COLUMNS 封闭列，RFC 4180）→ ExportStorage.put（注入端口，
 *   S3 由部署层接线）→ ExportUrlSigner.sign 短期 URL（默认 15 分钟，暂定值）→
 *   COMPLETED（rowCount/storageKey/downloadUrl/urlExpiresAt）；失败 → FAILED + error；
 * - 下载 URL 过期后不可用：urlExpiresAt 过后 downloadUrl=null、urlExpired=true；
 *   读取有效 URL 记审计 activity.export.download；
 * - 租户隔离：Customer 角色仅见本 Customer 导出任务（详情跨 Customer → 404）；
 * - 功能边界：不长期托管导出文件（存储对象生命周期由部署层策略清理）。
 */
import type { DbClient } from '@fdp/database';
import { audited, recordAudit } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { consoleNotFound } from './errors.js';
import { loadScopedDevice } from './service.js';
import type { DeviceConsoleDeps } from './service.js';
import { fetchAllDeviceActivities, parseActivityFilter } from './activity.js';
import type { ActivityFilter, ActivityItem } from './activity.js';

/** 短期下载 URL 有效期（秒，暂定值；部署层签名器应与其一致）。 */
export const ACTIVITY_EXPORT_URL_TTL_SECONDS = 900 as const;

/** CSV 封闭列（与 ActivityItem DTO 字段一致；EVENT/ALARM 两源并集列）。 */
export const ACTIVITY_CSV_COLUMNS = [
  'activityId',
  'kind',
  'level',
  'occurredAt',
  'summary',
  'eventType',
  'source',
  'userId',
  'username',
  'remarks',
  'code',
  'status',
  'message',
  'currentValue',
  'threshold',
  'unit',
] as const;

// ---------- 注入端口（部署层接 S3/签名实现；本模块无 AWS 依赖） ----------

export interface ActivityExportStorage {
  put(input: { readonly key: string; readonly body: string; readonly contentType: string }): Promise<void>;
}

export interface ActivityExportUrlSigner {
  sign(input: { readonly key: string; readonly expiresAt: Date }): string;
}

export interface ActivityExportDeps extends DeviceConsoleDeps {
  readonly storage: ActivityExportStorage;
  readonly urlSigner: ActivityExportUrlSigner;
  readonly urlTtlSeconds?: number;
}

// ---------- 行类型与 DTO ----------

interface ExportJobRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string | null;
  readonly requestedBy: string;
  readonly filters: unknown;
  readonly status: string;
  readonly rowCount: number | null;
  readonly storageKey: string | null;
  readonly downloadUrl: string | null;
  readonly urlExpiresAt: Date | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

interface ExportJobDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ExportJobRow | null>;
  findMany(args: Record<string, unknown>): Promise<never[]>;
  create(args: { data: Record<string, unknown> }): Promise<ExportJobRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function exportJobs(client: DbClient): ExportJobDelegate {
  return (client as unknown as Record<string, unknown>).activityExportJob as ExportJobDelegate;
}

export interface ActivityExportJobView {
  readonly exportId: string;
  readonly deviceId: string;
  readonly status: string;
  readonly filters: unknown;
  readonly rowCount: number | null;
  readonly downloadUrl: string | null;
  readonly urlExpiresAt: string | null;
  readonly urlExpired: boolean;
  readonly error: string | null;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

function toJobView(row: ExportJobRow, at: Date): ActivityExportJobView {
  const expired = row.urlExpiresAt !== null && row.urlExpiresAt.getTime() <= at.getTime();
  const urlUsable = row.status === 'COMPLETED' && row.downloadUrl !== null && !expired;
  return {
    exportId: row.id,
    deviceId: row.deviceId,
    status: row.status,
    filters: row.filters,
    rowCount: row.rowCount,
    downloadUrl: urlUsable ? row.downloadUrl : null,
    urlExpiresAt: row.urlExpiresAt?.toISOString() ?? null,
    urlExpired: row.status === 'COMPLETED' && expired,
    error: row.error,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

// ---------- CSV（RFC 4180，确定性：列序固定、行序 occurredAt 倒序） ----------

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function activityToCsv(items: readonly ActivityItem[]): string {
  const lines = [ACTIVITY_CSV_COLUMNS.join(',')];
  for (const item of items) {
    const row: Record<string, unknown> = {
      activityId: item.activityId,
      kind: item.kind,
      level: item.level,
      occurredAt: item.occurredAt,
      summary: item.summary,
      ...item.detail,
    };
    lines.push(ACTIVITY_CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---------- 创建（异步入队 + 审计） ----------

export async function createActivityExport(
  deps: ActivityExportDeps,
  actor: ActorContext,
  deviceId: string,
  filter: ActivityFilter,
): Promise<ActivityExportJobView> {
  const device = await loadScopedDevice(deps, actor, deviceId);
  // 校验并冻结筛选快照（非法配置在入队前拒绝）
  parseActivityFilter(filter);
  const frozenFilters: Record<string, unknown> = {
    ...(filter.level !== undefined ? { level: filter.level } : {}),
    ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
    ...(filter.from !== undefined ? { from: filter.from } : {}),
    ...(filter.to !== undefined ? { to: filter.to } : {}),
  };
  const now = deps.now?.() ?? new Date();
  const customerId = actor.actorType === 'customer' ? actor.customerId : device.customerId;

  return audited<ActivityExportJobView>(
    deps.client,
    {
      objectType: 'activity_export',
      objectId: deviceId,
      action: 'activity.export.create',
      reason: `device ${deviceId} activity export`,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId,
      afterValue: { deviceId, filters: frozenFilters },
    },
    async (tx) => {
      const job = await exportJobs(tx).create({
        data: {
          deviceId,
          customerId,
          requestedBy: actor.actorId,
          filters: frozenFilters,
          status: 'PENDING',
          createdAt: now,
        },
      });
      return toJobView(job, now);
    },
  );
}

// ---------- 详情（租户隔离 + 下载审计） ----------

export async function getActivityExport(
  deps: ActivityExportDeps,
  actor: ActorContext,
  exportId: string,
): Promise<ActivityExportJobView> {
  const now = deps.now?.() ?? new Date();
  const job = await exportJobs(deps.client).findFirst({ where: { id: exportId } });
  if (!job) throw consoleNotFound();
  if (actor.actorType === 'customer' && job.customerId !== actor.customerId) throw consoleNotFound();
  const view = toJobView(job, now);
  if (view.downloadUrl !== null) {
    await recordAudit(deps.client, {
      objectType: 'activity_export',
      objectId: job.id,
      action: 'activity.export.download',
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: job.customerId,
      result: 'SUCCESS',
      afterValue: { rowCount: job.rowCount, urlExpiresAt: job.urlExpiresAt?.toISOString() ?? null },
    });
  }
  return view;
}

// ---------- Export Worker ----------

export interface ActivityExportProcessResult {
  readonly processed: number;
  readonly completed: number;
  readonly failed: number;
}

export async function processActivityExportJobs(
  deps: ActivityExportDeps,
  options: { readonly batchSize?: number } = {},
): Promise<ActivityExportProcessResult> {
  const now = () => deps.now?.() ?? new Date();
  const ttl = deps.urlTtlSeconds ?? ACTIVITY_EXPORT_URL_TTL_SECONDS;
  const pending = (await exportJobs(deps.client).findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: options.batchSize ?? 10,
  })) as unknown as ExportJobRow[];

  let completed = 0;
  let failed = 0;
  for (const job of pending) {
    // 条件更新并发兜底：被其他 Worker 抢占则跳过
    const claimed = await exportJobs(deps.client).updateMany({
      where: { id: job.id, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count !== 1) continue;
    try {
      const filters = job.filters as ActivityFilter;
      const items = await fetchAllDeviceActivities(deps, job.deviceId, filters);
      const csv = activityToCsv(items);
      const storageKey = `activity-exports/${job.id}.csv`;
      await deps.storage.put({ key: storageKey, body: csv, contentType: 'text/csv' });
      const expiresAt = new Date(now().getTime() + ttl * 1000);
      const downloadUrl = deps.urlSigner.sign({ key: storageKey, expiresAt });
      await exportJobs(deps.client).updateMany({
        where: { id: job.id, status: 'PROCESSING' },
        data: {
          status: 'COMPLETED',
          rowCount: items.length,
          storageKey,
          downloadUrl,
          urlExpiresAt: expiresAt,
          completedAt: now(),
        },
      });
      completed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await exportJobs(deps.client).updateMany({
        where: { id: job.id, status: 'PROCESSING' },
        data: { status: 'FAILED', error: message.slice(0, 500), completedAt: now() },
      });
      failed += 1;
    }
  }
  return { processed: pending.length, completed, failed };
}
