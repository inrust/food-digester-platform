/**
 * BE-CMD-03 Command 列表/详情查询 Service（框架无关）。
 *
 * 规则：
 * - 权限：device:read（DEC-012 V1 矩阵无 command:read；命令查询为设备只读视图，复用 device:read，
 *   不扩矩阵——整体替换式演进留给后续决策）；
 * - 租户隔离：Customer 角色强制 actor.customerId scope；跨 Customer 详情 → 404（不泄露存在性）；
 * - 筛选：customerId/deviceId/status（COMMAND_STATUSES 枚举）/command（CT-04 白名单）/requestTime 范围；
 * - 分页：键集游标（id ASC，DB-02）；详情含 attempts 与 acks 时间线（审计链查询面）。
 */
import type { DbClient } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import { COMMAND_STATUSES, getCommandSpec } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { commandNotFound, commandValidationFailed } from './errors.js';

export interface CommandQueryDeps {
  readonly client: DbClient;
}

// ---------- 行类型与数据访问 ----------

interface CommandRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly command: string;
  readonly category: string;
  readonly highRisk: boolean;
  readonly status: string;
  readonly requestedBy: string;
  readonly requestTime: Date;
  readonly timeoutSec: number;
  readonly expiresAt: Date | null;
  readonly remarks: string | null;
  readonly confirmedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface AttemptRow {
  readonly attemptNo: number;
  readonly publishedAt: Date;
}

interface AckRow {
  readonly result: string;
  readonly executeTimeMs: number | null;
  readonly errorCode: string | null;
  readonly message: string | null;
  readonly ackAt: Date;
  readonly sourceMessageId: string | null;
}

interface CommandQueryDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CommandRow | null>;
  findMany(args: Record<string, unknown>): Promise<CommandRow[]>;
}

interface AttemptQueryDelegate {
  findMany(args: Record<string, unknown>): Promise<AttemptRow[]>;
}

interface AckQueryDelegate {
  findMany(args: Record<string, unknown>): Promise<AckRow[]>;
}

function commands(client: DbClient): CommandQueryDelegate {
  return (client as unknown as Record<string, unknown>).deviceCommand as CommandQueryDelegate;
}

function attempts(client: DbClient): AttemptQueryDelegate {
  return (client as unknown as Record<string, unknown>).commandAttempt as AttemptQueryDelegate;
}

function acks(client: DbClient): AckQueryDelegate {
  return (client as unknown as Record<string, unknown>).commandAck as AckQueryDelegate;
}

// ---------- DTO ----------

export interface CommandListItemView {
  readonly commandId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly command: string;
  readonly category: string;
  readonly highRisk: boolean;
  readonly status: string;
  readonly requestedBy: string;
  readonly requestTime: string;
  readonly timeoutSec: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommandAttemptView {
  readonly attemptNo: number;
  readonly publishedAt: string;
}

export interface CommandAckView {
  readonly result: string;
  readonly executeTimeMs: number | null;
  readonly errorCode: string | null;
  readonly message: string | null;
  readonly ackAt: string;
  readonly sourceMessageId: string | null;
}

export interface CommandDetailView extends CommandListItemView {
  readonly remarks: string | null;
  readonly confirmedBy: string | null;
  readonly attempts: readonly CommandAttemptView[];
  readonly acks: readonly CommandAckView[];
}

function toListItemView(row: CommandRow): CommandListItemView {
  return {
    commandId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    command: row.command,
    category: row.category,
    highRisk: row.highRisk,
    status: row.status,
    requestedBy: row.requestedBy,
    requestTime: row.requestTime.toISOString(),
    timeoutSec: row.timeoutSec,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------- 查询 ----------

export interface ListCommandsFilter {
  readonly customerId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly status?: string | undefined;
  readonly command?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

function parseTime(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw commandValidationFailed(`${field} must be a valid ISO 8601 timestamp`);
  return new Date(time);
}

/** Command 列表（device:read；Customer 角色强制租户 scope）。 */
export async function listCommands(
  deps: CommandQueryDeps,
  actor: ActorContext,
  filter: ListCommandsFilter = {},
): Promise<Page<CommandListItemView>> {
  if (filter.status !== undefined && !COMMAND_STATUSES.includes(filter.status as never)) {
    throw commandValidationFailed(`status must be one of: ${COMMAND_STATUSES.join(', ')}`);
  }
  if (filter.command !== undefined && !getCommandSpec(filter.command)) {
    throw commandValidationFailed(`Unknown command: ${filter.command}`);
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where: Record<string, unknown> = {};
  const customerId = actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : filter.customerId;
  if (customerId !== undefined) where.customerId = customerId;
  if (filter.deviceId) where.deviceId = filter.deviceId;
  if (filter.status) where.status = filter.status;
  if (filter.command) where.command = filter.command;
  const from = parseTime(filter.from, 'from');
  const to = parseTime(filter.to, 'to');
  if (from || to) {
    where.requestTime = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await commands(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toListItemView),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}

/** Command 详情（device:read；跨 Customer → 404 不泄露存在性）；含 attempts/acks 时间线。 */
export async function getCommandDetail(
  deps: CommandQueryDeps,
  actor: ActorContext,
  commandId: string,
): Promise<CommandDetailView> {
  const row = await commands(deps.client).findFirst({ where: { id: commandId } });
  if (!row) throw commandNotFound();
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw commandNotFound();
  const [attemptRows, ackRows] = await Promise.all([
    attempts(deps.client).findMany({ where: { commandId: row.id }, orderBy: { attemptNo: 'asc' } }),
    acks(deps.client).findMany({ where: { commandId: row.id }, orderBy: { ackAt: 'asc' } }),
  ]);
  return {
    ...toListItemView(row),
    remarks: row.remarks,
    confirmedBy: row.confirmedBy,
    attempts: attemptRows.map((a) => ({ attemptNo: a.attemptNo, publishedAt: a.publishedAt.toISOString() })),
    acks: ackRows.map((a) => ({
      result: a.result,
      executeTimeMs: a.executeTimeMs,
      errorCode: a.errorCode,
      message: a.message,
      ackAt: a.ackAt.toISOString(),
      sourceMessageId: a.sourceMessageId,
    })),
  };
}
