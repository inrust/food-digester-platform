/**
 * BE-OTA-03 OTA 状态接收 Handler（DEC-015：ACK 为唯一回传通道）。
 *
 * 事实源与规则：
 * - 唯一通道：既有 ACK 上行 Topic（bnx/device/{deviceId}/ack）；本模块不存在第二条
 *   回传通道，不新增 ota/status Topic、不采用 IoT Jobs 状态事件；
 * - 判别：data.objectType=OTA_TARGET + otaTargetId 关联目标；COMMAND 与 OTA_TARGET
 *   关联字段禁止混用（混带 commandId/command/result/executeTimeMs 一律拒绝）；
 *   objectType=COMMAND 移交 BE-CMD-03（handled=false）；
 * - 状态集合：DOWNLOADING/INSTALLING/SUCCEEDED/FAILED/ROLLED_BACK（DEC-015 冻结）；
 * - 设备绑定：ACK 的 Topic deviceId（AUTH-04 IoT Policy 保证设备只能发到自己的 Topic）
 *   必须等于 target.deviceId，否则拒绝且不产生任何状态变化；
 * - 状态迁移经 BE-OTA-02 recordTargetStatus（封闭迁移表 + 条件更新并发兜底）；
 *   重复上报幂等（同状态重放不重复写历史/归档）；迟到 ACK（target 已终态/取消）
 *   不产生状态变化；
 * - DEC-016：每次被接受的状态变化写 OPERATION_RECORD/RESULT 归档记录
 *   （来源固定为 DEC-015 ACK OTA_TARGET）；
 * - 入口假设：Envelope 结构（meta+data）已由 Ingress 按 ack.schema.json 校验；
 *   本 Handler 仍对 OTA 业务字段做防御性校验。
 */
import type { OtaCampaignDeps } from '../admin/ota-campaign/service.js';
import { recordTargetStatus } from '../admin/ota-campaign/service.js';
import { resolveOtaArchiveCustomerId } from './publisher.js';

/** DEC-015 冻结的 OTA 上行状态集合。 */
export const OTA_ACK_STATUSES = ['DOWNLOADING', 'INSTALLING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK'] as const;
export type OtaAckStatus = (typeof OTA_ACK_STATUSES)[number];

/** DEC-015：COMMAND 专属字段，OTA_TARGET 报文混带即拒绝（两类字段禁止混用）。 */
const COMMAND_ONLY_FIELDS = ['commandId', 'command', 'result', 'executeTimeMs'] as const;

export interface OtaAckInput {
  /** Topic 解析出的设备 ID（AUTH-04：设备只能发布到自己的 Topic）。 */
  readonly deviceId: string;
  readonly ack: {
    readonly meta: { readonly id: string; readonly ts: string };
    readonly data: Record<string, unknown>;
  };
}

export interface OtaAckResult {
  /** false = 非 OTA_TARGET（移交 BE-CMD-03 COMMAND 处理）。 */
  readonly handled: boolean;
  /** true = 状态已迁移（或幂等重放）。 */
  readonly applied: boolean;
  readonly replayed?: boolean;
  readonly reason?:
    'INVALID_ACK' | 'MIXED_FIELDS' | 'TARGET_NOT_FOUND' | 'DEVICE_MISMATCH' | 'TARGET_TERMINAL' | 'ILLEGAL_TRANSITION';
}

interface TargetRow {
  readonly id: string;
  readonly campaignId: string;
  readonly deviceId: string;
  readonly status: string;
}

export type OtaAckHandlerDeps = OtaCampaignDeps;

function reject(reason: NonNullable<OtaAckResult['reason']>): OtaAckResult {
  return { handled: true, applied: false, reason };
}

/**
 * 处理 ACK 上行报文中的 OTA 状态回传（DEC-015 唯一通道）。
 * 所有业务拒绝均以返回值表达（不抛出），供 IoT Rule/Lambda 消费者安全调用。
 */
export async function handleOtaAck(deps: OtaAckHandlerDeps, input: OtaAckInput): Promise<OtaAckResult> {
  const now = deps.now?.() ?? new Date();
  const data = input.ack?.data;
  if (!data || typeof data !== 'object') return reject('INVALID_ACK');
  if (data.objectType !== 'OTA_TARGET') return { handled: false, applied: false };

  // DEC-015：关联键为 otaTargetId；COMMAND 字段混带一律拒绝
  if (COMMAND_ONLY_FIELDS.some((f) => data[f] !== undefined)) return reject('MIXED_FIELDS');
  const otaTargetId = data.otaTargetId;
  const status = data.status;
  if (typeof otaTargetId !== 'string' || otaTargetId.length === 0) return reject('INVALID_ACK');
  if (typeof status !== 'string' || !(OTA_ACK_STATUSES as readonly string[]).includes(status)) {
    return reject('INVALID_ACK');
  }
  const errorCode = typeof data.errorCode === 'string' ? data.errorCode : null;
  const message = typeof data.message === 'string' ? data.message : null;

  const otaTargets = (deps.client as unknown as Record<string, unknown>).otaTarget as {
    findFirst(args: { where: Record<string, unknown> }): Promise<TargetRow | null>;
  };
  const target = await otaTargets.findFirst({ where: { id: otaTargetId } });
  if (!target) return reject('TARGET_NOT_FOUND');
  // 设备绑定：Topic deviceId 必须等于目标设备（非目标设备的报文不产生任何状态变化）
  if (target.deviceId !== input.deviceId) return reject('DEVICE_MISMATCH');

  // 幂等重放：同状态重复上报不写历史/归档
  if (target.status === status) {
    return { handled: true, applied: true, replayed: true };
  }
  // 迟到 ACK：target 已终态（含取消）不产生状态变化
  if (['SUCCEEDED', 'ROLLED_BACK', 'CANCELLED'].includes(target.status)) {
    return reject('TARGET_TERMINAL');
  }

  try {
    await recordTargetStatus(deps, target.id, status, {
      ackId: input.ack.meta.id,
      ...(errorCode !== null ? { errorCode } : {}),
      ...(message !== null ? { message } : {}),
    });
  } catch {
    return reject('ILLEGAL_TRANSITION');
  }

  // DEC-016：RESULT 归档记录（来源固定为 DEC-015 ACK OTA_TARGET）
  const customerId = await resolveOtaArchiveCustomerId(deps.client, target.deviceId);
  await (
    (deps.client as unknown as Record<string, unknown>).outboxEvent as {
      create(args: { data: Record<string, unknown> }): Promise<unknown>;
    }
  ).create({
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
        deviceId: target.deviceId,
        occurredAt: now.toISOString(),
        data: {
          campaignId: target.campaignId,
          targetId: target.id,
          status,
          ackId: input.ack.meta.id,
          source: 'DEC-015_ACK_OTA_TARGET',
          ...(errorCode !== null ? { errorCode } : {}),
          ...(message !== null ? { message } : {}),
        },
      },
    },
  });
  return { handled: true, applied: true, replayed: false };
}
