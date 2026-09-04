/**
 * BE-CMD-03 / DEC-015 ACK Handler：命令回执与 OTA Target 状态共用唯一 ack 上行通道。
 *
 * 事实源与规则：
 * - Payload：contracts/mqtt/schemas/ack.schema.json（meta.seq 必填上行；data.commandId/command/result
 *   字段级弱必填，本 Handler 自行强制 commandId/command；result 仅允许 SUCCESS|FAILED，可缺省=收到确认）；
 * - 状态机：packages/domain/src/command.ts classifyAck（实施方案 §11.7 + §9.3 前置状态校验）；
 * - ACK commandId/command 必须与原命令匹配，且 deviceId 必须一致（防跨设备伪造回执）→ 否则隔离；
 * - 未知 commandId → 隔离（无法落 command_acks 外键，且属安全异常）；
 * - 未发布（CREATED/AUTHORIZED/PUBLISHING）收到 ACK → 隔离（设备不可能持有）；
 * - 迟到 ACK（TIMED_OUT/终态）：command_acks 保存为事件，不得把 TimedOut 静默改成功；
 * - 幂等：receipt 键 {deviceId}:ack:{seq}（processWithReceipt）；command_acks.sourceMessageId 唯一约束兜底；
 * - 审计链：每次真实处理写 audit_logs（actorId=deviceId/actorRole=device，command.ack）+ 归档 Outbox。
 *
 * 功能边界：不负责设备执行与定时器运维调度（timeout evaluator 见 cloud-api admin/command/timeout.ts）。
 */
import type { DbClient } from '@fdp/database';
import { ackResultForStorage, classifyAck } from '@fdp/domain';
import type { AckWireResult } from '@fdp/domain';
import { canTransitionOtaStatus, isOtaWireStatus } from '@fdp/contracts/mqtt/ota-status-channel-policy.js';
import { quarantineError } from '../ingest/errors.js';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import type { ReceiptOutcome } from '../ingest/receipt.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';
import { requireCustomerId, writeArchiveOutbox } from './archive.js';

export interface AckHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export type AckAction = 'applied' | 'event-only' | 'ota-applied' | 'ota-event-only';

export interface AckHandleResult {
  readonly handled: boolean;
  readonly outcome: ReceiptOutcome | undefined;
  readonly action: AckAction | undefined;
  /** action=applied 时的目标状态。 */
  readonly toStatus: string | undefined;
  readonly archived: boolean;
}

const NOT_HANDLED: AckHandleResult = {
  handled: false,
  outcome: undefined,
  action: undefined,
  toStatus: undefined,
  archived: false,
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseAckResult(value: unknown): AckWireResult | null {
  if (value === undefined || value === null) return null;
  if (value === 'SUCCESS' || value === 'FAILED') return value;
  throw quarantineError('INVALID_ENVELOPE', 'data.result', 'ack result must be SUCCESS or FAILED');
}

function parseExecuteTimeMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw quarantineError('INVALID_ENVELOPE', 'data.executeTimeMs', 'executeTimeMs must be a non-negative integer');
  }
  return value;
}

interface CommandRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly command: string;
  readonly status: string;
}

interface CommandDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CommandRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface AckDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

interface AuditDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

interface OtaTargetRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
}

interface OtaTargetDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<OtaTargetRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface OtaHistoryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

function commands(client: DbClient): CommandDelegate {
  return (client as unknown as Record<string, unknown>).deviceCommand as CommandDelegate;
}

function commandAcks(client: DbClient): AckDelegate {
  return (client as unknown as Record<string, unknown>).commandAck as AckDelegate;
}

function auditLogs(client: DbClient): AuditDelegate {
  return (client as unknown as Record<string, unknown>).auditLog as AuditDelegate;
}

function otaTargets(client: DbClient): OtaTargetDelegate {
  return (client as unknown as Record<string, unknown>).otaTarget as OtaTargetDelegate;
}

function otaHistory(client: DbClient): OtaHistoryDelegate {
  return (client as unknown as Record<string, unknown>).otaStatusHistory as OtaHistoryDelegate;
}

function hasAny(data: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => data[key] !== undefined);
}

async function handleOtaTargetAck(deps: AckHandlerDeps, message: ValidatedMessage): Promise<AckHandleResult> {
  const data = message.data;
  if (hasAny(data, ['commandId', 'command', 'result', 'executeTimeMs'])) {
    throw quarantineError('INVALID_ENVELOPE', 'data.objectType', 'OTA_TARGET ack cannot contain command fields');
  }
  const otaTargetId = asString(data.otaTargetId);
  const status = asString(data.status);
  if (!otaTargetId || !status || !isOtaWireStatus(status)) {
    throw quarantineError(
      'INVALID_ENVELOPE',
      'data.otaTargetId',
      'OTA_TARGET ack requires otaTargetId and valid status',
    );
  }
  const errorCode = asString(data.errorCode) ?? null;
  const ackMessage = asString(data.message) ?? null;
  const meta = message.envelope.payload.meta as Record<string, unknown>;
  const seq = Number(meta.seq);
  const deviceId = message.device.deviceId;
  const payloadHash = hashPayload(message.envelope.payload);
  const occurredAt = new Date(message.occurredAt);
  const now = deps.now?.() ?? new Date();

  const processed = await processWithReceipt(deps.client, {
    key: { deviceId, topicType: 'ack', seq },
    payloadHash,
    receivedAtMs: message.envelope.iotReceivedAt,
    business: async (tx) => {
      const customerId = requireCustomerId(message.device.customerId);
      const target = await otaTargets(tx).findFirst({ where: { id: otaTargetId } });
      if (!target) {
        throw quarantineError(
          'UNKNOWN_OTA_TARGET',
          'data.otaTargetId',
          `ack references unknown OTA target ${otaTargetId}`,
        );
      }
      if (target.deviceId !== deviceId) {
        throw quarantineError('OTA_TARGET_MISMATCH', 'data.otaTargetId', 'ack device does not own the OTA target');
      }
      if (!canTransitionOtaStatus(target.status, status)) {
        throw quarantineError(
          'INVALID_OTA_STATE',
          'data.status',
          `OTA target cannot transition from ${target.status} to ${status}`,
        );
      }

      const sameStatus = target.status === status;
      if (!sameStatus) {
        const terminal = ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'].includes(status);
        const { count } = await otaTargets(tx).updateMany({
          where: { id: target.id, deviceId, status: target.status },
          data: { status, completedAt: terminal ? occurredAt : null },
        });
        if (count !== 1) {
          throw quarantineError('INVALID_OTA_STATE', 'data.status', 'OTA target state changed concurrently');
        }
      }
      await otaHistory(tx).create({
        data: {
          targetId: target.id,
          fromStatus: target.status,
          toStatus: status,
          detail: { sourceMessageId: message.messageId, errorCode, message: ackMessage },
          createdAt: occurredAt,
        },
      });
      await auditLogs(tx).create({
        data: {
          actorId: deviceId,
          actorRole: 'device',
          customerId,
          objectType: 'ota_target',
          objectId: target.id,
          action: 'ota.status.ack',
          beforeValue: { status: target.status },
          afterValue: { status, errorCode },
          result: 'SUCCESS',
          createdAt: now,
        },
      });
      const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
      await outbox.create({
        data: {
          eventType: 'ARCHIVE',
          aggregateType: 'ota_target',
          aggregateId: target.id,
          payload: {
            archiveClass: 'OPERATION_RECORD',
            envelopeVersion: '1.0',
            operationType: 'ota',
            recordType: 'RESULT',
            aggregateId: target.id,
            customerId,
            deviceId,
            occurredAt: message.occurredAt,
            data: {
              otaTargetId: target.id,
              fromStatus: target.status,
              toStatus: status,
              errorCode,
              message: ackMessage,
              sourceMessageId: message.messageId,
            },
          },
        },
      });
      return {
        action: (sameStatus ? 'ota-event-only' : 'ota-applied') as AckAction,
        toStatus: status,
      };
    },
  });

  if (processed.outcome === 'DUPLICATE_SKIPPED') {
    return { handled: true, outcome: processed.outcome, action: undefined, toStatus: undefined, archived: false };
  }
  return {
    handled: true,
    outcome: processed.outcome,
    action: processed.result?.action,
    toStatus: processed.result?.toStatus,
    archived: true,
  };
}

export function createAckHandler(deps: AckHandlerDeps): (message: ValidatedMessage) => Promise<AckHandleResult> {
  return async (message) => {
    if (message.envelope.iotType !== 'ack') return NOT_HANDLED;

    const data = message.data;
    const objectType = asString(data.objectType);
    if (objectType === 'OTA_TARGET') return handleOtaTargetAck(deps, message);
    if (objectType !== 'COMMAND') {
      throw quarantineError('INVALID_ENVELOPE', 'data.objectType', 'ack objectType must be COMMAND or OTA_TARGET');
    }
    if (hasAny(data, ['otaTargetId', 'status'])) {
      throw quarantineError('INVALID_ENVELOPE', 'data.objectType', 'COMMAND ack cannot contain OTA target fields');
    }
    const commandId = asString(data.commandId);
    const command = asString(data.command);
    if (!commandId || !command) {
      throw quarantineError('INVALID_ENVELOPE', 'data.commandId', 'ack missing commandId or command');
    }
    const result = parseAckResult(data.result);
    const executeTimeMs = parseExecuteTimeMs(data.executeTimeMs);
    const errorCode = asString(data.errorCode) ?? null;
    const ackMessage = asString(data.message) ?? null;

    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const seq = Number(meta.seq);
    const deviceId = message.device.deviceId;
    const payloadHash = hashPayload(message.envelope.payload);
    const auditHash = ((message.audit as Record<string, unknown> | null)?.hash as string | undefined) ?? null;
    const ackAt = new Date(message.occurredAt);
    const now = deps.now?.() ?? new Date();

    const processed = await processWithReceipt(deps.client, {
      key: { deviceId, topicType: 'ack', seq },
      payloadHash,
      receivedAtMs: message.envelope.iotReceivedAt,
      business: async (tx) => {
        const customerId = requireCustomerId(message.device.customerId);
        const row = await commands(tx).findFirst({ where: { id: commandId } });
        if (!row) {
          throw quarantineError('UNKNOWN_COMMAND', 'data.commandId', `ack references unknown command ${commandId}`);
        }
        // ACK commandId/command 必须与原命令匹配；deviceId 必须一致（防跨设备伪造回执）
        if (row.deviceId !== deviceId) {
          throw quarantineError('COMMAND_MISMATCH', 'data.commandId', 'ack device does not own the command');
        }
        if (row.command !== command) {
          throw quarantineError(
            'COMMAND_MISMATCH',
            'data.command',
            `ack command ${command} does not match original ${row.command}`,
          );
        }

        const outcome = classifyAck(row.status, result);
        if (outcome.kind === 'INVALID_PRECONDITION') {
          throw quarantineError(
            'INVALID_COMMAND_STATE',
            'data.commandId',
            `command ${commandId} is ${row.status}; device cannot hold it`,
          );
        }

        // 保存 ACK 事件（applied 与迟到/重复均落 command_acks；sourceMessageId 唯一约束兜底并发）
        await commandAcks(tx).create({
          data: {
            commandId: row.id,
            result: ackResultForStorage(result),
            executeTimeMs,
            errorCode,
            message: ackMessage,
            ackAt,
            sourceMessageId: message.messageId,
          },
        });

        let toStatus: string | undefined;
        if (outcome.kind === 'APPLY') {
          // 条件更新（并发漂移兜底：状态被并发迁移则降级为事件，不覆盖）
          const { count } = await commands(tx).updateMany({
            where: { id: row.id, status: row.status },
            data: { status: outcome.to },
          });
          toStatus = count === 1 ? outcome.to : undefined;
        }
        // 审计链：actor 为设备（deviceId），记录迁移前后状态与 ACK 结果
        await auditLogs(tx).create({
          data: {
            actorId: deviceId,
            actorRole: 'device',
            customerId: row.customerId,
            objectType: 'device_command',
            objectId: row.id,
            action: 'command.ack',
            beforeValue: { status: row.status },
            afterValue: { status: toStatus ?? row.status, ackResult: ackResultForStorage(result), executeTimeMs },
            result: 'SUCCESS',
            createdAt: now,
          },
        });
        await writeArchiveOutbox(tx, {
          topicType: 'ack',
          messageId: message.messageId,
          deviceId,
          customerId,
          occurredAt: message.occurredAt,
          receivedAtMs: message.envelope.iotReceivedAt,
          payloadHash,
          auditHash,
          columns: {
            commandId: row.id,
            command: row.command,
            statusBefore: row.status,
            statusAfter: toStatus ?? row.status,
            ackResult: ackResultForStorage(result),
          },
          payload: message.envelope.payload,
        });
        return { action: (toStatus ? 'applied' : 'event-only') as AckAction, toStatus };
      },
    });

    if (processed.outcome === 'DUPLICATE_SKIPPED') {
      return { handled: true, outcome: processed.outcome, action: undefined, toStatus: undefined, archived: false };
    }
    return {
      handled: true,
      outcome: processed.outcome,
      action: processed.result?.action,
      toStatus: processed.result?.toStatus,
      archived: true,
    };
  };
}
