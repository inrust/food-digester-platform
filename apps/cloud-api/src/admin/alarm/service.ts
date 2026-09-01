/**
 * BE-ALM-01 Alarm/Event/Tamper 查询与处理 Service（框架无关）。
 *
 * 事实源与规则：
 * - 写入侧为 BE-IOT-07（设备上报 ACTIVE 插入新行、CLEARED 条件关闭同 code ACTIVE 行）；
 *   本模块只做管理端查询与处理（确认/清除），不创建 Alarm；
 * - 状态机走领域层（packages/domain/src/alarm.ts）：ACTIVE→ACKNOWLEDGED→CLEARED、
 *   ACTIVE→CLEARED；终态 CLEARED 无出边；非法跳转/并发状态漂移 → 409 CONFLICT；
 * - 确认/清除记录操作者、原因和时间（acknowledgedBy/acknowledgedAt/acknowledgeReason、
 *   clearedBy/clearedAt/clearReason 落库 + DOM-03 audited 审计 alarm.acknowledge/alarm.clear）；
 * - 幂等：ACKNOWLEDGED 重复确认、CLEARED 重复清除 → replayed=true（无写入/审计/领域事件）；
 * - Critical 业务通知：仅当 CRITICAL 告警发生真实状态迁移时，发布一个领域事件
 *   （OutboxEvent eventType=ALARM_STATE_CHANGED，aggregateType=alarm）供通知适配器消费；
 *   非 CRITICAL 迁移与幂等重放均不产生领域事件（领域通知只在状态变化时产生）；
 * - 权限：查询 alarm:read（全角色）；确认/清除 alarm:write（PlatformSuperAdmin/PlatformOperator）；
 *   Customer 角色租户隔离（actor.customerId 强制 scope；跨 Customer 详情/处理 → 404）；
 * - 筛选与分页：severity/status/deviceId/siteId（经 devices 归属解析）/customerId/时间范围 +
 *   键集游标（id ASC，DB-02 游标语义）。
 *
 * 功能边界：不实现 AWS 资源运维告警和人工值守。
 */
import type { DbClient } from '@fdp/database';
import { audited, decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import { ALARM_SEVERITIES, ALARM_STATUSES, assertAlarmTransition } from '@fdp/domain';
import type { AlarmStatus } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { alarmConflict, alarmNotFound, alarmValidationFailed } from './errors.js';

/** Critical 告警状态迁移领域事件（通知适配器消费 Outbox）。 */
export const ALARM_STATE_CHANGED_EVENT = 'ALARM_STATE_CHANGED' as const;

export interface AlarmDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

// ---------- 行类型与数据访问 ----------

interface AlarmRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly code: string;
  readonly category: string;
  readonly severity: string;
  readonly status: string;
  readonly detectedTime: Date;
  readonly component: string | null;
  readonly currentValue: string | null;
  readonly threshold: string | null;
  readonly unit: string | null;
  readonly message: string | null;
  readonly recommendedAction: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgeReason: string | null;
  readonly clearedBy: string | null;
  readonly clearedAt: Date | null;
  readonly clearReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface EventRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly eventType: string;
  readonly userId: string | null;
  readonly username: string | null;
  readonly source: string | null;
  readonly remarks: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

interface TamperRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly eventType: string;
  readonly severity: string;
  readonly component: string | null;
  readonly details: unknown;
  readonly actionTaken: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

interface AlarmDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<AlarmRow | null>;
  findMany(args: Record<string, unknown>): Promise<AlarmRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface EventDelegate {
  findMany(args: Record<string, unknown>): Promise<EventRow[]>;
}

interface TamperDelegate {
  findMany(args: Record<string, unknown>): Promise<TamperRow[]>;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

interface DeviceScopeDelegate {
  findMany(args: { where: Record<string, unknown>; select: Record<string, boolean> }): Promise<{ id: string }[]>;
}

function alarms(client: DbClient): AlarmDelegate {
  return (client as unknown as Record<string, unknown>).alarm as AlarmDelegate;
}

function deviceEvents(client: DbClient): EventDelegate {
  return (client as unknown as Record<string, unknown>).deviceEvent as EventDelegate;
}

function tamperEvents(client: DbClient): TamperDelegate {
  return (client as unknown as Record<string, unknown>).tamperEvent as TamperDelegate;
}

function outbox(client: DbClient): OutboxDelegate {
  return (client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
}

function devices(client: DbClient): DeviceScopeDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceScopeDelegate;
}

// ---------- DTO ----------

export interface AlarmView {
  readonly alarmId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly code: string;
  readonly category: string;
  readonly severity: string;
  readonly status: string;
  readonly detectedTime: string;
  readonly component: string | null;
  readonly currentValue: string | null;
  readonly threshold: string | null;
  readonly unit: string | null;
  readonly message: string | null;
  readonly recommendedAction: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgeReason: string | null;
  readonly clearedBy: string | null;
  readonly clearedAt: string | null;
  readonly clearReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeviceEventView {
  readonly eventId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly eventType: string;
  readonly userId: string | null;
  readonly username: string | null;
  readonly source: string | null;
  readonly remarks: string | null;
  readonly occurredAt: string;
}

export interface TamperEventView {
  readonly tamperEventId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly eventType: string;
  readonly severity: string;
  readonly component: string | null;
  readonly details: unknown;
  readonly actionTaken: string | null;
  readonly occurredAt: string;
}

function toAlarmView(row: AlarmRow): AlarmView {
  return {
    alarmId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    code: row.code,
    category: row.category,
    severity: row.severity,
    status: row.status,
    detectedTime: row.detectedTime.toISOString(),
    component: row.component,
    currentValue: row.currentValue,
    threshold: row.threshold,
    unit: row.unit,
    message: row.message,
    recommendedAction: row.recommendedAction,
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgeReason: row.acknowledgeReason,
    clearedBy: row.clearedBy,
    clearedAt: row.clearedAt?.toISOString() ?? null,
    clearReason: row.clearReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEventView(row: EventRow): DeviceEventView {
  return {
    eventId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    eventType: row.eventType,
    userId: row.userId,
    username: row.username,
    source: row.source,
    remarks: row.remarks,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function toTamperView(row: TamperRow): TamperEventView {
  return {
    tamperEventId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    eventType: row.eventType,
    severity: row.severity,
    component: row.component,
    details: row.details,
    actionTaken: row.actionTaken,
    occurredAt: row.occurredAt.toISOString(),
  };
}

// ---------- 筛选与租户隔离 ----------

/** Customer 角色强制所属 Customer scope；平台角色可按 customerId 筛选。 */
function scopedCustomerId(actor: ActorContext, requested?: string): string | undefined {
  return actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : requested;
}

function assertEnum(value: string | undefined, allowed: readonly string[], field: string): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw alarmValidationFailed(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

function parseTime(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw alarmValidationFailed(`${field} must be a valid ISO 8601 timestamp`);
  return new Date(time);
}

/** siteId 筛选 → 设备归属解析（alarms/events/tamper 无 site 关系列）。 */
async function deviceIdsOfSite(client: DbClient, siteId: string): Promise<string[]> {
  const rows = await devices(client).findMany({ where: { siteId }, select: { id: true } });
  return rows.map((r) => r.id);
}

interface BaseListFilter {
  readonly customerId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

async function buildScopedWhere(
  client: DbClient,
  actor: ActorContext,
  filter: BaseListFilter,
  timeField: 'detectedTime' | 'occurredAt',
): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = {};
  const customerId = scopedCustomerId(actor, filter.customerId);
  if (customerId !== undefined) where.customerId = customerId;
  if (filter.deviceId) where.deviceId = filter.deviceId;
  if (filter.siteId) {
    const deviceIds = await deviceIdsOfSite(client, filter.siteId);
    // 无归属设备 → 空结果（不可能匹配的占位条件）
    where.deviceId = deviceIds.length > 0 ? { in: deviceIds } : '__none__';
  }
  const from = parseTime(filter.from, 'from');
  const to = parseTime(filter.to, 'to');
  if (from || to) {
    where[timeField] = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  return where;
}

function paginate<TRow extends { id: string }, TView>(
  rows: TRow[],
  limit: number,
  toView: (row: TRow) => TView,
): Page<TView> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toView),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}

// ---------- Alarm 查询 ----------

export interface ListAlarmsFilter extends BaseListFilter {
  readonly severity?: string | undefined;
  readonly status?: string | undefined;
}

/** Alarm 列表（alarm:read）：severity/status/device/site/时间范围筛选 + 键集游标分页。 */
export async function listAlarms(
  deps: AlarmDeps,
  actor: ActorContext,
  filter: ListAlarmsFilter = {},
): Promise<Page<AlarmView>> {
  assertEnum(filter.severity, ALARM_SEVERITIES, 'severity');
  assertEnum(filter.status, ALARM_STATUSES, 'status');
  const limit = normalizeLimit(filter.limit ?? null);
  const where = await buildScopedWhere(deps.client, actor, filter, 'detectedTime');
  if (filter.severity) where.severity = filter.severity;
  if (filter.status) where.status = filter.status;
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await alarms(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  return paginate(rows, limit, toAlarmView);
}

/** Alarm 详情（alarm:read；跨 Customer → 404 不泄露存在性）。 */
export async function getAlarm(deps: AlarmDeps, actor: ActorContext, alarmId: string): Promise<AlarmView> {
  const row = await alarms(deps.client).findFirst({ where: { id: alarmId } });
  if (!row) throw alarmNotFound();
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw alarmNotFound();
  return toAlarmView(row);
}

// ---------- Alarm 处理（确认/清除） ----------

export interface AlarmHandleInput {
  readonly alarmId: string;
  /** 操作原因（强制，落库 + 审计）。 */
  readonly reason: string;
}

export interface AlarmHandleResult {
  readonly view: AlarmView;
  /** 幂等重放：目标状态已达成，无写入/审计/领域事件。 */
  readonly replayed: boolean;
}

async function loadAlarmForWrite(deps: AlarmDeps, actor: ActorContext, alarmId: string): Promise<AlarmRow> {
  const row = await alarms(deps.client).findFirst({ where: { id: alarmId } });
  if (!row) throw alarmNotFound();
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw alarmNotFound();
  return row;
}

/** Critical 告警真实状态迁移 → 一个领域事件（Outbox，通知适配器消费）。 */
async function emitCriticalStateChanged(
  tx: DbClient,
  row: AlarmRow,
  to: AlarmStatus,
  actor: ActorContext,
  at: Date,
): Promise<void> {
  if (row.severity !== 'CRITICAL') return;
  await outbox(tx).create({
    data: {
      eventType: ALARM_STATE_CHANGED_EVENT,
      aggregateType: 'alarm',
      aggregateId: row.id,
      payload: {
        type: ALARM_STATE_CHANGED_EVENT,
        alarmId: row.id,
        deviceId: row.deviceId,
        customerId: row.customerId,
        code: row.code,
        severity: row.severity,
        fromStatus: row.status,
        toStatus: to,
        actorId: actor.actorId,
        occurredAt: at.toISOString(),
      },
    },
  });
}

async function transitionAlarm(
  deps: AlarmDeps,
  actor: ActorContext,
  input: AlarmHandleInput,
  target: 'ACKNOWLEDGED' | 'CLEARED',
  action: 'alarm.acknowledge' | 'alarm.clear',
): Promise<AlarmHandleResult> {
  const row = await loadAlarmForWrite(deps, actor, input.alarmId);
  const from = row.status as AlarmStatus;
  // 幂等重放：目标状态已达成（重复确认/重复清除）
  if (from === target) return { view: toAlarmView(row), replayed: true };
  // 领域校验：非法迁移（如 CLEARED 再确认）→ 409
  try {
    assertAlarmTransition(from, target);
  } catch {
    throw alarmConflict(`The alarm status transition from ${from} to ${target} is not allowed`);
  }

  const at = deps.now?.() ?? new Date();
  const data =
    target === 'ACKNOWLEDGED'
      ? { status: target, acknowledgedBy: actor.actorId, acknowledgedAt: at, acknowledgeReason: input.reason }
      : { status: target, clearedBy: actor.actorId, clearedAt: at, clearReason: input.reason };

  return audited<AlarmHandleResult>(
    deps.client,
    {
      objectType: 'alarm',
      objectId: row.id,
      action,
      reason: input.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: row.customerId,
      beforeValue: { status: from },
      afterValue: { status: target },
    },
    async (tx) => {
      // 条件更新（并发状态漂移 → 409）；同事务发布 Critical 领域事件
      const { count } = await alarms(tx).updateMany({ where: { id: row.id, status: from }, data });
      if (count !== 1) {
        throw alarmConflict('The alarm status changed concurrently; refresh and retry');
      }
      await emitCriticalStateChanged(tx, row, target, actor, at);
      const fresh = await alarms(tx).findFirst({ where: { id: row.id } });
      if (!fresh) throw alarmNotFound();
      return { view: toAlarmView(fresh), replayed: false };
    },
  );
}

/** 确认（alarm:write）：ACTIVE → ACKNOWLEDGED；重复确认幂等重放。 */
export async function acknowledgeAlarm(
  deps: AlarmDeps,
  actor: ActorContext,
  input: AlarmHandleInput,
): Promise<AlarmHandleResult> {
  return transitionAlarm(deps, actor, input, 'ACKNOWLEDGED', 'alarm.acknowledge');
}

/** 清除（alarm:write）：ACTIVE/ACKNOWLEDGED → CLEARED；重复清除幂等重放。 */
export async function clearAlarm(
  deps: AlarmDeps,
  actor: ActorContext,
  input: AlarmHandleInput,
): Promise<AlarmHandleResult> {
  return transitionAlarm(deps, actor, input, 'CLEARED', 'alarm.clear');
}

// ---------- Event / Tamper 只读查询 ----------

export interface ListEventsFilter extends BaseListFilter {
  readonly eventType?: string | undefined;
}

/** Event 列表（alarm:read；只读）。 */
export async function listDeviceEvents(
  deps: AlarmDeps,
  actor: ActorContext,
  filter: ListEventsFilter = {},
): Promise<Page<DeviceEventView>> {
  const limit = normalizeLimit(filter.limit ?? null);
  const where = await buildScopedWhere(deps.client, actor, filter, 'occurredAt');
  if (filter.eventType) where.eventType = filter.eventType;
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await deviceEvents(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  return paginate(rows, limit, toEventView);
}

export interface ListTamperEventsFilter extends BaseListFilter {
  readonly eventType?: string | undefined;
  readonly severity?: string | undefined;
}

/** Tamper 列表（alarm:read；只读）。 */
export async function listTamperEvents(
  deps: AlarmDeps,
  actor: ActorContext,
  filter: ListTamperEventsFilter = {},
): Promise<Page<TamperEventView>> {
  assertEnum(filter.severity, ALARM_SEVERITIES, 'severity');
  const limit = normalizeLimit(filter.limit ?? null);
  const where = await buildScopedWhere(deps.client, actor, filter, 'occurredAt');
  if (filter.eventType) where.eventType = filter.eventType;
  if (filter.severity) where.severity = filter.severity;
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await tamperEvents(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  return paginate(rows, limit, toTamperView);
}
