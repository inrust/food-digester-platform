/**
 * BE-CERT-03 管理员证书轮换发起 Service（业务核心，框架无关）。
 *
 * 流程（单事务）：
 * 1. 资格：设备存在（404）；生命周期须允许轮换（Onboarded/Active/Suspended；
 *    Retired 与 Onboarding 中状态 → 409 DEVICE_STATE_NOT_ALLOWED）；
 *    设备须有 ACTIVE 证书（全撤销/无证书 → 409 CONFLICT）；
 * 2. 幂等：同设备已有 PENDING 请求 → 重放原请求（200 语义由 Handler 决定），
 *    不重复创建、不重复通知；并发发起由部分唯一索引兜底（P2002 → 回读胜出记录）；
 * 3. 创建请求 + Outbox 事件（CERTIFICATE_ROTATION_REQUIRED，bnx/device/{id}/notification，
 *    CT-03/CT-04 契约；实际 MQTT 发布由下行分发器消费 outbox）+ DOM-03 审计。
 *
 * 功能边界：管理端不生成/下载设备私钥（设备经 BE-CERT-02 自行轮换领取）；
 * 响应只含证书 ID/状态/到期日/请求状态，绝不含 PEM/私钥。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { AdminOnboardingError } from '../onboarding/errors.js';

/** 允许发起轮换的生命周期（通信设计 + DOM-01；Retired/Onboarding 中一律拒绝） */
const ROTATABLE_LIFECYCLE = new Set(['Onboarded', 'Active', 'Suspended']);

/** CT-03 下行通知 Topic 模板（topic-catalog.json topicPattern） */
const notificationTopic = (deviceId: string): string => `bnx/device/${deviceId}/notification`;

/** CT-04 Notification 目录类型 */
export const ROTATION_REQUIRED_NOTIFICATION = 'CERTIFICATE_ROTATION_REQUIRED' as const;

export interface RotationRequestRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly certificateId: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly notifiedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface RotationRequestView {
  readonly requestId: string;
  readonly deviceId: string;
  readonly certificateId: string;
  readonly certificateStatus: string;
  /** 当前证书 UTC 到期日（YYYY-MM-DD）。 */
  readonly expiryDate: string;
  readonly requestStatus: string;
  readonly requestedAt: string;
}

export interface CreateRotationRequestResult {
  readonly view: RotationRequestView;
  /** true 表示命中既有 PENDING 请求的幂等重放（未新建、未重复通知）。 */
  readonly replayed: boolean;
}

interface DeviceRow {
  readonly id: string;
  readonly lifecycleStatus: string;
}

interface CertificateRow {
  readonly id: string;
  readonly status: string;
  readonly notAfter: Date;
}

function rotationRequests(client: DbClient) {
  return (client as unknown as Record<string, unknown>).certificateRotationRequest as {
    findFirst(args: { where: Record<string, unknown> }): Promise<RotationRequestRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<RotationRequestRecord>;
  };
}

function certificates(client: DbClient) {
  return (client as unknown as Record<string, unknown>).deviceCertificate as {
    findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'P2002';
}

function toView(request: RotationRequestRecord, cert: CertificateRow): RotationRequestView {
  return {
    requestId: request.id,
    deviceId: request.deviceId,
    certificateId: cert.id,
    certificateStatus: cert.status,
    expiryDate: cert.notAfter.toISOString().slice(0, 10),
    requestStatus: request.status,
    requestedAt: request.createdAt.toISOString(),
  };
}

export async function createCertificateRotationRequest(
  client: DbClient,
  deviceId: string,
  actor: ActorContext,
  now: () => Date = () => new Date(),
): Promise<CreateRotationRequestResult> {
  const devices = (client as unknown as Record<string, unknown>).device as {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  };
  const device = await devices.findFirst({ where: { id: deviceId } });
  if (!device) throw new AdminOnboardingError('NOT_FOUND', `设备不存在: ${deviceId}`);
  if (!ROTATABLE_LIFECYCLE.has(device.lifecycleStatus)) {
    throw new AdminOnboardingError('DEVICE_STATE_NOT_ALLOWED', `生命周期不允许发起证书轮换: ${device.lifecycleStatus}`);
  }
  const cert = await certificates(client).findFirst({ where: { deviceId, status: 'ACTIVE' } });
  if (!cert) {
    throw new AdminOnboardingError('CONFLICT', '设备无 ACTIVE 证书，无法发起轮换');
  }

  // 幂等：已有未完成（PENDING）请求 → 重放，不重复通知
  const existing = await rotationRequests(client).findFirst({ where: { deviceId, status: 'PENDING' } });
  if (existing) {
    return { view: toView(existing, cert), replayed: true };
  }

  try {
    return await withTransaction(client, async (tx) => {
      const request = await rotationRequests(tx).create({
        data: {
          deviceId,
          certificateId: cert.id,
          status: 'PENDING',
          requestedBy: actor.actorId,
          notifiedAt: now(),
        },
      });
      // CT-04 通知经 Outbox 下发（由下行分发器发布 MQTT；本任务不直接发布）
      const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
      await outbox.create({
        data: {
          eventType: ROTATION_REQUIRED_NOTIFICATION,
          aggregateType: 'device',
          aggregateId: deviceId,
          payload: {
            topic: notificationTopic(deviceId),
            data: { type: ROTATION_REQUIRED_NOTIFICATION },
            requestId: request.id,
          },
        },
      });
      await recordAudit(tx, {
        objectType: 'certificateRotationRequest',
        objectId: request.id,
        action: 'CERT_ROTATION_REQUEST',
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        result: 'SUCCESS',
        afterValue: {
          deviceId,
          certificateId: cert.id,
          requestStatus: 'PENDING',
          notification: ROTATION_REQUIRED_NOTIFICATION,
        },
      });
      return { view: toView(request, cert), replayed: false };
    });
  } catch (err) {
    // 并发重复点击：部分唯一索引拒绝，回读胜出记录幂等返回
    if (isUniqueViolation(err)) {
      const winner = await rotationRequests(client).findFirst({ where: { deviceId, status: 'PENDING' } });
      if (winner) return { view: toView(winner, cert), replayed: true };
    }
    throw err;
  }
}
