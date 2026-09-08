/**
 * BE-ESG-02 异步 CSV 导出 Service + Export Worker（框架无关）。
 *
 * 规则：
 * - 创建导出（export:create = PlatformSuperAdmin/Auditor/CustomerAdmin）：冻结筛选快照 +
 *   Customer scope（Customer 角色强制本 Customer），DOM-03 审计 esg.export.create；异步执行
 *   （本模块仅入队 PENDING，Export Worker 处理）；
 * - Worker（processEsgExportJobs）：PENDING→PROCESSING（条件更新并发兜底）→ 复用查询
 *   Service 同源 where（过滤结果与 CSV 行数一致）→ CSV（ESG_CSV_SCHEMAS 封闭列）→
 *   ExportStorage.put（注入端口，S3 由部署层接线）→ ExportUrlSigner.sign 短期 URL
 *   （默认 15 分钟，暂定值）→ COMPLETED（rowCount/storageKey/downloadUrl/urlExpiresAt）；
 *   失败 → FAILED + error；
 * - 下载 URL 过期后不可用：详情在 urlExpiresAt 过后不返回 URL（urlExpired=true）；
 *   签发 URL 的读取（COMPLETED 且未过期）记审计 esg.export.download；
 * - 租户隔离：Customer 角色仅见本 Customer 导出任务（详情跨 Customer → 404）；
 * - 功能边界：不长期托管导出文件（存储对象生命周期由部署层策略清理；本表仅存引用与过期语义）。
 */
import type { DbClient } from '@fdp/database';
import { audited, recordAudit } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ESG_EXPORT_DATASETS, toCsv } from './csv.js';
import type { EsgExportDataset } from './csv.js';
import { buildEsgWhere, toSummaryView, toDailyView, toHourlyView, toReportView } from './service.js';
import type { EsgFilter } from './service.js';
import { esgNotFound, esgValidationFailed } from './errors.js';
import { randomUUID } from 'node:crypto';

/** 短期下载 URL 有效期（秒，暂定值；部署层签名器应与其一致）。 */
export const EXPORT_URL_TTL_SECONDS = 900 as const;

// ---------- 注入端口（部署层接 S3/签名实现；本模块无 AWS 依赖） ----------

export interface ExportStorage {
  put(input: { readonly key: string; readonly body: string; readonly contentType: string }): Promise<void>;
}

export interface ExportUrlSigner {
  sign(input: { readonly key: string; readonly expiresAt: Date }): string | Promise<string>;
}

export interface EsgExportDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly storage: ExportStorage;
  readonly urlSigner: ExportUrlSigner;
  readonly urlTtlSeconds?: number;
  readonly leaseSeconds?: number;
}

// ---------- 行类型与 DTO ----------

interface ExportJobRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly requestedBy: string;
  readonly dataset: string;
  readonly filters: unknown;
  readonly status: string;
  readonly rowCount: number | null;
  readonly storageKey: string | null;
  readonly downloadUrl: string | null;
  readonly urlExpiresAt: Date | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly leaseUntil?: Date | null;
  readonly leaseToken?: string | null;
}

interface ExportJobDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ExportJobRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<ExportJobRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function exportJobs(client: DbClient): ExportJobDelegate {
  return (client as unknown as Record<string, unknown>).esgExportJob as ExportJobDelegate;
}

export interface EsgExportJobView {
  readonly exportId: string;
  readonly dataset: string;
  readonly status: string;
  readonly filters: unknown;
  readonly rowCount: number | null;
  /** COMPLETED 且未过期时为短期下载 URL；过期/未完成时为 null。 */
  readonly downloadUrl: string | null;
  readonly urlExpiresAt: string | null;
  readonly urlExpired: boolean;
  readonly error: string | null;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

function toJobView(row: ExportJobRow, at: Date): EsgExportJobView {
  const expired = row.urlExpiresAt !== null && row.urlExpiresAt.getTime() <= at.getTime();
  const urlUsable = row.status === 'COMPLETED' && row.downloadUrl !== null && !expired;
  return {
    exportId: row.id,
    dataset: row.dataset,
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

// ---------- 创建（异步入队 + 审计） ----------

export interface CreateEsgExportInput {
  readonly dataset: string;
  readonly customerId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export async function createEsgExport(
  deps: EsgExportDeps,
  actor: ActorContext,
  input: CreateEsgExportInput,
): Promise<EsgExportJobView> {
  if (!(ESG_EXPORT_DATASETS as readonly string[]).includes(input.dataset)) {
    throw esgValidationFailed(`dataset must be one of: ${ESG_EXPORT_DATASETS.join(', ')}`);
  }
  for (const [field, value] of [
    ['from', input.from],
    ['to', input.to],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw esgValidationFailed(`${field} must be a valid ISO 8601 timestamp`);
    }
  }
  // Customer 角色强制本 Customer scope；平台角色可指定或全量（customerId 为空）
  const scopeCustomerId = actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : input.customerId;
  const filters = {
    ...(scopeCustomerId !== undefined ? { customerId: scopeCustomerId } : {}),
    ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.from !== undefined ? { from: new Date(input.from).toISOString() } : {}),
    ...(input.to !== undefined ? { to: new Date(input.to).toISOString() } : {}),
  };
  const at = deps.now?.() ?? new Date();

  return audited<EsgExportJobView>(
    deps.client,
    {
      objectType: 'esg_export',
      objectId: '(pending)',
      action: 'esg.export.create',
      reason: `dataset=${input.dataset}`,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: scopeCustomerId ?? null,
      afterValue: (result: EsgExportJobView) => ({
        exportId: result.exportId,
        dataset: result.dataset,
        filters: result.filters,
      }),
    },
    async (tx) => {
      const row = await exportJobs(tx).create({
        data: {
          customerId: scopeCustomerId ?? null,
          requestedBy: actor.actorId,
          dataset: input.dataset,
          filters,
          status: 'PENDING',
        },
      });
      return toJobView(row, at);
    },
  );
}

// ---------- 详情（含短期 URL 过期语义 + 下载审计） ----------

export async function getEsgExport(
  deps: EsgExportDeps,
  actor: ActorContext,
  exportId: string,
): Promise<EsgExportJobView> {
  const row = await exportJobs(deps.client).findFirst({ where: { id: exportId } });
  if (!row) throw esgNotFound();
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw esgNotFound();
  const at = deps.now?.() ?? new Date();
  const view = toJobView(row, at);
  // 签发可用 URL 的读取记下载审计（DOM-03）；过期/未完成不记
  if (view.downloadUrl !== null) {
    await recordAudit(deps.client, {
      objectType: 'esg_export',
      objectId: row.id,
      action: 'esg.export.download',
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: row.customerId,
      afterValue: { dataset: row.dataset, rowCount: row.rowCount, urlExpiresAt: row.urlExpiresAt?.toISOString() },
      result: 'SUCCESS',
    });
  }
  return view;
}

// ---------- Export Worker ----------

const TIME_FIELD_BY_DATASET: Readonly<
  Record<EsgExportDataset, 'bucketStart' | 'bucketDate' | 'periodStartTime' | 'summaryDate'>
> = {
  HOURLY: 'bucketStart',
  DAILY: 'bucketDate',
  REPORTS: 'periodStartTime',
  DAILY_SUMMARY: 'summaryDate',
} as const;

interface QueryDelegate {
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

function tableOf(client: DbClient, dataset: EsgExportDataset): QueryDelegate {
  const accessor = {
    HOURLY: 'telemetryHourly',
    DAILY: 'telemetryDaily',
    REPORTS: 'esgReport',
    DAILY_SUMMARY: 'esgDailySummary',
  }[dataset];
  return (client as unknown as Record<string, unknown>)[accessor] as QueryDelegate;
}

const VIEW_BY_DATASET = {
  HOURLY: toHourlyView,
  DAILY: toDailyView,
  REPORTS: toReportView,
  DAILY_SUMMARY: toSummaryView,
} as const;

/** 处理一个导出任务（PENDING→PROCESSING→COMPLETED/FAILED；条件更新并发兜底）。 */
export async function processEsgExportJob(deps: EsgExportDeps, exportId: string): Promise<EsgExportJobView> {
  const at = deps.now?.() ?? new Date();
  const job = await exportJobs(deps.client).findFirst({ where: { id: exportId } });
  if (!job) throw esgNotFound();
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return toJobView(job, at);

  // PENDING 或租约过期的 PROCESSING → PROCESSING（并发兜底：仅一个执行者获胜）
  const leaseToken = randomUUID();
  const leaseUntil = new Date(at.getTime() + (deps.leaseSeconds ?? 300) * 1000);
  const claimed = await exportJobs(deps.client).updateMany({
    where: {
      id: job.id,
      OR: [{ status: 'PENDING' }, { status: 'PROCESSING', OR: [{ leaseUntil: null }, { leaseUntil: { lte: at } }] }],
    },
    data: { status: 'PROCESSING', claimedAt: at, leaseUntil, leaseToken, attemptCount: { increment: 1 }, error: null },
  });
  if (claimed.count !== 1) {
    const current = await exportJobs(deps.client).findFirst({ where: { id: job.id } });
    if (!current) throw esgNotFound();
    return toJobView(current, at);
  }

  try {
    const dataset = job.dataset as EsgExportDataset;
    const filter = (job.filters ?? {}) as EsgFilter;
    // 与查询 Service 同源 where（customerId 快照即 scope）→ 过滤结果与 CSV 行数一致
    const where = await buildEsgWhere(deps.client, filter.customerId, filter, TIME_FIELD_BY_DATASET[dataset]);
    if (dataset === 'REPORTS' && filter.reportType) where.reportType = filter.reportType;
    const rows = await tableOf(deps.client, dataset).findMany({ where, orderBy: { id: 'asc' } });
    const toView = VIEW_BY_DATASET[dataset] as unknown as (row: Record<string, unknown>) => Record<string, unknown>;
    const views = rows.map((r) => toView(r));
    const csv = toCsv(dataset, views);

    const storageKey = `esg-exports/${job.id}.csv`;
    await deps.storage.put({ key: storageKey, body: csv, contentType: 'text/csv; charset=utf-8' });
    const expiresAt = new Date(at.getTime() + (deps.urlTtlSeconds ?? EXPORT_URL_TTL_SECONDS) * 1000);
    const downloadUrl = await deps.urlSigner.sign({ key: storageKey, expiresAt });

    await exportJobs(deps.client).updateMany({
      where: { id: job.id, status: 'PROCESSING', leaseToken },
      data: {
        status: 'COMPLETED',
        rowCount: views.length,
        storageKey,
        downloadUrl,
        urlExpiresAt: expiresAt,
        completedAt: at,
        leaseUntil: null,
        leaseToken: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'export failed';
    await exportJobs(deps.client).updateMany({
      where: { id: job.id, status: 'PROCESSING', leaseToken },
      data: { status: 'FAILED', error: message, completedAt: at, leaseUntil: null, leaseToken: null },
    });
  }

  const fresh = await exportJobs(deps.client).findFirst({ where: { id: job.id } });
  if (!fresh) throw esgNotFound();
  return toJobView(fresh, at);
}

/** 批量处理 PENDING 及租约过期的 PROCESSING 导出任务（部署层定时触发）。 */
export async function processEsgExportJobs(deps: EsgExportDeps, batchSize = 10): Promise<number> {
  const delegate = exportJobs(deps.client) as unknown as {
    findMany(args: Record<string, unknown>): Promise<{ id: string }[]>;
  };
  const pending = await delegate.findMany({
    where: {
      OR: [
        { status: 'PENDING' },
        {
          status: 'PROCESSING',
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: deps.now?.() ?? new Date() } }],
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true },
  });
  for (const row of pending) {
    await processEsgExportJob(deps, row.id);
  }
  return pending.length;
}
