/**
 * BE-RPL-01 Replay Job Repository：列表（键集游标分页）与详情查询。
 */
import type { DbClient } from '@fdp/database';
import { AdminOnboardingError } from '../onboarding/errors.js';
import type { ReplayJobView, ReplayScope } from './service.js';

interface ReplayJobRow {
  readonly id: string;
  readonly requestedBy: string;
  readonly scope: unknown;
  readonly status: string;
  readonly resultSummary: unknown;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

interface ReplayJobDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ReplayJobRow | null>;
  findMany(args: Record<string, unknown>): Promise<ReplayJobRow[]>;
}

function jobs(client: DbClient): ReplayJobDelegate {
  return (client as unknown as Record<string, unknown>).replayJob as ReplayJobDelegate;
}

export function toView(row: ReplayJobRow): ReplayJobView {
  return {
    jobId: row.id,
    scope: row.scope as ReplayScope,
    status: row.status,
    resultSummary: row.resultSummary,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function findReplayJobById(client: DbClient, jobId: string): Promise<ReplayJobView> {
  const row = await jobs(client).findFirst({ where: { id: jobId } });
  if (!row) throw new AdminOnboardingError('NOT_FOUND', `Replay Job 不存在: ${jobId}`);
  return toView(row);
}

export interface ReplayJobListPage {
  readonly items: ReplayJobView[];
  readonly nextCursor: string | null;
}

function encodeCursor(row: ReplayJobRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!iso || !id || Number.isNaN(Date.parse(iso))) throw new Error('bad cursor');
    return { createdAt: new Date(iso), id };
  } catch {
    throw new AdminOnboardingError('VALIDATION_FAILED', 'invalid cursor');
  }
}

/** 键集游标分页（createdAt DESC, id DESC）；可选 customerId/status 过滤。 */
export async function listReplayJobs(
  client: DbClient,
  options: { limit: number; cursor?: string | undefined; customerId?: string | undefined; status?: string | undefined },
): Promise<ReplayJobListPage> {
  const where: Record<string, unknown> = {};
  if (options.customerId) where.scope = { path: ['customerId'], equals: options.customerId };
  if (options.status) where.status = options.status;
  if (options.cursor) {
    const { createdAt, id } = decodeCursor(options.cursor);
    where.OR = [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }];
  }
  const rows = await jobs(client).findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toView),
    nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
  };
}
