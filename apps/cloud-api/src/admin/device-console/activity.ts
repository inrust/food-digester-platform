/**
 * BE-DEV-05 设备活动日志查询（框架无关，只读）。
 *
 * 活动流 = device_events（EVENT）∪ alarms（ALARM）两源合并：
 * - 级别派生（固定规则）：ALARM 取告警 severity（INFO/WARNING/MAJOR/CRITICAL）；
 *   EVENT 固定 INFO（DeviceEvent 无级别字段）；
 * - 筛选：level / kind / occurredAt 时间范围（from/to 含端点）；
 * - 排序：occurredAt 倒序 + id 决胜（排序稳定）；复合键集游标 `${iso}|${id}`
 *   （复用共享游标编码；游标条件同构施加于两源后内存归并）；
 * - Customer scope：经 loadScopedDevice 强制（跨 Customer → 404）；
 * - 导出复用：fetchAllDeviceActivities 与查询同源（筛选结果与 CSV 一致），
 *   分批拉取并有总量上限（ACTIVITY_EXPORT_MAX_ROWS），非数据库不限量同步查询。
 */
import type { DbClient, Page } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { consoleValidationFailed } from './errors.js';
import { loadScopedDevice } from './service.js';
import type { DeviceConsoleDeps } from './service.js';

/** 导出最大行数（防止不限量同步查询；暂定值）。 */
export const ACTIVITY_EXPORT_MAX_ROWS = 10_000;

const CURSOR_KEY_SEPARATOR = '|';

export const ACTIVITY_LEVELS = ['INFO', 'WARNING', 'MAJOR', 'CRITICAL'] as const;
export const ACTIVITY_KINDS = ['EVENT', 'ALARM'] as const;

// ---------- 行类型 ----------

interface EventRow {
  readonly id: string;
  readonly eventType: string;
  readonly source: string | null;
  readonly userId: string | null;
  readonly username: string | null;
  readonly remarks: string | null;
  readonly occurredAt: Date;
}

interface AlarmRow {
  readonly id: string;
  readonly code: string;
  readonly severity: string;
  readonly status: string;
  readonly message: string | null;
  readonly currentValue: string | null;
  readonly threshold: string | null;
  readonly unit: string | null;
  readonly detectedTime: Date;
}

interface TableDelegate {
  findMany(args: Record<string, unknown>): Promise<never[]>;
}

function table(client: DbClient, name: string): TableDelegate {
  return (client as unknown as Record<string, unknown>)[name] as TableDelegate;
}

// ---------- DTO ----------

export interface ActivityItem {
  readonly activityId: string;
  readonly kind: 'EVENT' | 'ALARM';
  readonly level: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly detail: Record<string, unknown>;
}

export interface ActivityFilter {
  readonly level?: string | undefined;
  readonly kind?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

// ---------- 校验与游标 ----------

interface ParsedFilter {
  readonly level?: string;
  readonly kind?: 'EVENT' | 'ALARM';
  readonly from?: Date;
  readonly to?: Date;
  readonly cursorTime?: Date;
  readonly cursorId?: string;
}

export function parseActivityFilter(filter: ActivityFilter): ParsedFilter {
  const parsed: {
    level?: string;
    kind?: 'EVENT' | 'ALARM';
    from?: Date;
    to?: Date;
    cursorTime?: Date;
    cursorId?: string;
  } = {};
  if (filter.level !== undefined) {
    if (!(ACTIVITY_LEVELS as readonly string[]).includes(filter.level)) {
      throw consoleValidationFailed(`level must be one of: ${ACTIVITY_LEVELS.join(', ')}`);
    }
    parsed.level = filter.level;
  }
  if (filter.kind !== undefined) {
    if (!(ACTIVITY_KINDS as readonly string[]).includes(filter.kind)) {
      throw consoleValidationFailed(`kind must be one of: ${ACTIVITY_KINDS.join(', ')}`);
    }
    parsed.kind = filter.kind as 'EVENT' | 'ALARM';
  }
  for (const [field, value] of [
    ['from', filter.from],
    ['to', filter.to],
  ] as const) {
    if (value === undefined) continue;
    const time = Date.parse(value);
    if (Number.isNaN(time)) throw consoleValidationFailed(`${field} must be a valid date-time`);
    parsed[field] = new Date(time);
  }
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) {
    const sep = after.lastIndexOf(CURSOR_KEY_SEPARATOR);
    const cursorTime = sep > 0 ? Date.parse(after.slice(0, sep)) : Number.NaN;
    const cursorId = sep > 0 ? after.slice(sep + 1) : '';
    if (Number.isNaN(cursorTime) || cursorId.length === 0) throw consoleValidationFailed('cursor is invalid');
    parsed.cursorTime = new Date(cursorTime);
    parsed.cursorId = cursorId;
  }
  return parsed;
}

function timeCondition(
  timeField: string,
  parsed: ParsedFilter,
  cursor?: { readonly time: Date; readonly id: string },
): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [];
  if (parsed.from || parsed.to) {
    conditions.push({
      [timeField]: { ...(parsed.from ? { gte: parsed.from } : {}), ...(parsed.to ? { lte: parsed.to } : {}) },
    });
  }
  const cursorTime = cursor?.time ?? parsed.cursorTime;
  const cursorId = cursor?.id ?? parsed.cursorId;
  if (cursorTime && cursorId) {
    conditions.push({
      OR: [{ [timeField]: { lt: cursorTime } }, { [timeField]: cursorTime, id: { lt: cursorId } }],
    });
  }
  return conditions;
}

// ---------- 查询 ----------

async function fetchEvents(
  client: DbClient,
  deviceId: string,
  parsed: ParsedFilter,
  take: number,
  cursor?: { readonly time: Date; readonly id: string },
  customerId?: string | null,
): Promise<ActivityItem[]> {
  if (parsed.kind === 'ALARM') return [];
  // EVENT 固定 INFO：level 筛选非 INFO 时事件源为空
  if (parsed.level !== undefined && parsed.level !== 'INFO') return [];
  const rows = (await table(client, 'deviceEvent').findMany({
    where: {
      AND: [
        { deviceId, ...(customerId !== undefined ? { customerId } : {}) },
        ...timeCondition('occurredAt', parsed, cursor),
      ],
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take,
  })) as unknown as EventRow[];
  return rows.map((row) => ({
    activityId: row.id,
    kind: 'EVENT' as const,
    level: 'INFO',
    occurredAt: row.occurredAt.toISOString(),
    summary: row.eventType,
    detail: {
      eventType: row.eventType,
      source: row.source,
      userId: row.userId,
      username: row.username,
      remarks: row.remarks,
    },
  }));
}

async function fetchAlarms(
  client: DbClient,
  deviceId: string,
  parsed: ParsedFilter,
  take: number,
  cursor?: { readonly time: Date; readonly id: string },
  customerId?: string | null,
): Promise<ActivityItem[]> {
  if (parsed.kind === 'EVENT') return [];
  const rows = (await table(client, 'alarm').findMany({
    where: {
      AND: [
        { deviceId, ...(customerId !== undefined ? { customerId } : {}) },
        ...(parsed.level !== undefined ? [{ severity: parsed.level }] : []),
        ...timeCondition('detectedTime', parsed, cursor),
      ],
    },
    orderBy: [{ detectedTime: 'desc' }, { id: 'desc' }],
    take,
  })) as unknown as AlarmRow[];
  return rows.map((row) => ({
    activityId: row.id,
    kind: 'ALARM' as const,
    level: row.severity,
    occurredAt: row.detectedTime.toISOString(),
    summary: row.code,
    detail: {
      code: row.code,
      severity: row.severity,
      status: row.status,
      message: row.message,
      currentValue: row.currentValue,
      threshold: row.threshold,
      unit: row.unit,
    },
  }));
}

/** 归并排序：occurredAt 倒序 + activityId 决胜。 */
function mergeByOccurredAtDesc(a: readonly ActivityItem[], b: readonly ActivityItem[]): ActivityItem[] {
  return [...a, ...b].sort((x, y) =>
    x.occurredAt === y.occurredAt ? y.activityId.localeCompare(x.activityId) : y.occurredAt.localeCompare(x.occurredAt),
  );
}

export async function listDeviceActivities(
  deps: DeviceConsoleDeps,
  actor: ActorContext,
  deviceId: string,
  filter: ActivityFilter = {},
): Promise<Page<ActivityItem>> {
  const device = await loadScopedDevice(deps, actor, deviceId);
  const parsed = parseActivityFilter(filter);
  const limit = normalizeLimit(filter.limit ?? null);

  const [events, alarms] = await Promise.all([
    fetchEvents(deps.client, deviceId, parsed, limit + 1, undefined, device.customerId),
    fetchAlarms(deps.client, deviceId, parsed, limit + 1, undefined, device.customerId),
  ]);
  const merged = mergeByOccurredAtDesc(events, alarms);
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor:
      merged.length > limit && last
        ? encodeKeysetCursor(`${last.occurredAt}${CURSOR_KEY_SEPARATOR}${last.activityId}`)
        : null,
  };
}

/** 导出用全量拉取（与查询同源；每源独立游标分批翻页，总量上限 ACTIVITY_EXPORT_MAX_ROWS）。 */
export async function fetchAllDeviceActivities(
  deps: DeviceConsoleDeps,
  deviceId: string,
  filter: ActivityFilter,
  maxRows: number = ACTIVITY_EXPORT_MAX_ROWS,
  customerId?: string | null,
): Promise<ActivityItem[]> {
  const parsed = parseActivityFilter(filter);
  const baseCursor =
    parsed.cursorTime && parsed.cursorId ? { time: parsed.cursorTime, id: parsed.cursorId } : undefined;
  const out: ActivityItem[] = [];
  const batch = 500;
  // 每源独立游标：未被本轮消费的行不推进其源游标，下一轮重取——不丢不重
  let eventCursor = baseCursor;
  let alarmCursor = baseCursor;
  for (;;) {
    const needed = maxRows - out.length;
    if (needed <= 0) break;
    const [events, alarms] = await Promise.all([
      fetchEvents(deps.client, deviceId, parsed, batch, eventCursor, customerId),
      fetchAlarms(deps.client, deviceId, parsed, batch, alarmCursor, customerId),
    ]);
    if (events.length === 0 && alarms.length === 0) break;
    const merged = mergeByOccurredAtDesc(events, alarms);
    const consumed = merged.slice(0, Math.min(batch, needed));
    out.push(...consumed);
    const lastEvent = [...consumed].reverse().find((item: ActivityItem) => item.kind === 'EVENT');
    const lastAlarm = [...consumed].reverse().find((item: ActivityItem) => item.kind === 'ALARM');
    if (lastEvent) eventCursor = { time: new Date(lastEvent.occurredAt), id: lastEvent.activityId };
    if (lastAlarm) alarmCursor = { time: new Date(lastAlarm.occurredAt), id: lastAlarm.activityId };
    // 两源均已耗尽（返回不足批大小且无更多可消费）→ 结束
    if (events.length < batch && alarms.length < batch && merged.length <= consumed.length) break;
  }
  return out;
}
