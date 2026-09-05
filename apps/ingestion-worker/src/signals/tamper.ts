/**
 * BE-IOT-07 Tamper Handler：安全事件保存 + 归档（audit.hash）+ 策略自动挂起。
 *
 * - 保存 tamper_events 历史（audit.hash 由 CT-03 Schema 强制，随归档载荷保留，DEC-002）；
 * - 策略：severity ∈ TAMPER_SUSPEND_SEVERITIES（当前 CRITICAL）→ DOM-01 生命周期
 *   Active → Suspended（SYSTEM actor，策略原因必填）；
 * - 只挂起一次：预检 lifecycleStatus='Active' + 条件更新兜底（并发/重复/已挂起 → 不再迁移）；
 * - 挂起必须有审计：stateHistory（lifecycle+operational 镜像）+ recordAudit(SUCCESS) 与
 *   tamper 事件、归档在同一 receipt 事务提交。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit } from '@fdp/database';
import { transitionLifecycle } from '@fdp/domain';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import type { ReceiptOutcome } from '../ingest/receipt.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';
import { requireCustomerId, writeArchiveOutbox, writeCriticalAlertOutbox } from './archive.js';

/** 触发自动挂起的 Tamper 严重度策略（封闭集合，协议冻结前 V1）。 */
export const TAMPER_SUSPEND_SEVERITIES = ['CRITICAL'] as const;

export interface TamperHandlerDeps {
  readonly client: DbClient;
}

export interface TamperHandleResult {
  readonly handled: boolean;
  readonly outcome: ReceiptOutcome | undefined;
  /** 本次是否执行了策略挂起（已挂起/非 Active/重复 → false）。 */
  readonly suspended: boolean;
  readonly archived: boolean;
}

const NOT_HANDLED: TamperHandleResult = { handled: false, outcome: undefined, suspended: false, archived: false };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface TamperDelegate {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string; lifecycleStatus: string } | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface StateHistoryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

/** 策略挂起（在 receipt 事务内调用）：仅 Active 设备迁移一次，返回是否本次执行。 */
async function suspendDeviceForTamper(
  tx: DbClient,
  params: { readonly deviceId: string; readonly customerId: string; readonly eventType: string },
): Promise<boolean> {
  const devices = (tx as unknown as Record<string, unknown>).device as DeviceDelegate;
  const device = await devices.findFirst({ where: { id: params.deviceId } });
  if (device?.lifecycleStatus !== 'Active') return false; // 只挂起一次：已 Suspended/其他状态静默跳过

  const reason = `TAMPER_AUTO_SUSPEND: severity=CRITICAL, eventType=${params.eventType}`;
  const effects = transitionLifecycle(
    { id: device.id, lifecycleStatus: 'Active', operationalStatus: 'Active' },
    'Suspended',
    { actorType: 'SYSTEM', actorId: 'system:tamper-policy' },
    { reason },
  );
  // 并发兜底：仅一个事务完成迁移
  const { count } = await devices.updateMany({
    where: { id: device.id, lifecycleStatus: 'Active' },
    data: { lifecycleStatus: 'Suspended' },
  });
  if (count !== 1) return false;

  const history = (tx as unknown as Record<string, unknown>).deviceStateHistory as StateHistoryDelegate;
  for (const entry of effects.stateHistory) {
    await history.create({
      data: {
        deviceId: entry.deviceId,
        axis: entry.axis,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorType: entry.actorType,
        actorId: entry.actorId,
        reason: entry.reason,
      },
    });
  }
  await recordAudit(tx, {
    objectType: 'device',
    objectId: device.id,
    action: 'device.lifecycle.Active_to_Suspended',
    actorId: 'system:tamper-policy',
    customerId: params.customerId,
    reason,
    beforeValue: { lifecycleStatus: 'Active', operationalStatus: 'Active' },
    afterValue: { lifecycleStatus: 'Suspended', operationalStatus: 'Suspended', policy: 'TAMPER_AUTO_SUSPEND' },
    result: 'SUCCESS',
  });
  return true;
}

export function createTamperHandler(
  deps: TamperHandlerDeps,
): (message: ValidatedMessage) => Promise<TamperHandleResult> {
  return async (message) => {
    if (message.envelope.iotType !== 'tamper') return NOT_HANDLED;

    const data = message.data;
    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const seq = Number(meta.seq);
    const deviceId = message.device.deviceId;
    const payloadHash = hashPayload(message.envelope.payload);
    const auditHash = ((message.audit as Record<string, unknown> | null)?.hash as string | undefined) ?? null;
    const severity = asString(data.severity) ?? 'INFO';
    const eventType = asString(data.eventType) ?? 'UNKNOWN';

    const processed = await processWithReceipt(deps.client, {
      key: { deviceId, topicType: 'tamper', seq },
      payloadHash,
      receivedAtMs: message.envelope.iotReceivedAt,
      business: async (tx) => {
        const customerId = requireCustomerId(message.device.customerId);
        const columns = {
          deviceId,
          customerId,
          eventType,
          severity,
          component: asString(data.component) ?? null,
          details: asString(data.details) ?? null,
          actionTaken: asString(data.actionTaken) ?? null,
          occurredAt: new Date(message.occurredAt),
          sourceMessageId: message.messageId,
        };
        const tampers = (tx as unknown as Record<string, unknown>).tamperEvent as TamperDelegate;
        const created = await tampers.create({ data: columns });
        // BE-ALM-02 生产侧：CRITICAL Tamper → 领域事件（通知适配器消费；非 CRITICAL 不产生）
        if (severity === 'CRITICAL') {
          await writeCriticalAlertOutbox(tx, {
            type: 'CRITICAL_ALERT_RAISED',
            kind: 'tamper',
            tamperEventId: created.id,
            deviceId,
            customerId,
            severity: 'CRITICAL',
            occurredAt: new Date(message.occurredAt).toISOString(),
            eventType,
            component: columns.component as string | null,
          });
        }
        await writeArchiveOutbox(tx, {
          topicType: 'tamper',
          messageId: message.messageId,
          deviceId,
          customerId,
          occurredAt: message.occurredAt,
          receivedAtMs: message.envelope.iotReceivedAt,
          payloadHash,
          auditHash,
          columns,
          payload: message.envelope.payload,
        });
        // 策略挂起（同事务：事件 + 归档 + 迁移 + 审计原子提交）
        const shouldSuspend = (TAMPER_SUSPEND_SEVERITIES as readonly string[]).includes(severity);
        return shouldSuspend ? suspendDeviceForTamper(tx, { deviceId, customerId, eventType }) : false;
      },
    });

    if (processed.outcome === 'DUPLICATE_SKIPPED') {
      return { handled: true, outcome: processed.outcome, suspended: false, archived: false };
    }
    return { handled: true, outcome: processed.outcome, suspended: processed.result ?? false, archived: true };
  };
}
