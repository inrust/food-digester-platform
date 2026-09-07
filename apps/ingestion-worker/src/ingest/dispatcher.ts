/**
 * BE-IOT-08 业务分发器：将校验通过的 ValidatedMessage 按 iotType 路由到对应 Handler。
 *
 * 事实源与规则：
 * - 路由表（封闭，与 contracts/mqtt/topics.ts 上行 Topic 目录一致）：
 *   heartbeat → Heartbeat Handler（连接状态/首次心跳副作用）；
 *   telemetry → Telemetry Handler（整点聚合）；report → Report Handler；
 *   alarm/event/tamper → 对应 Signal Handler；ack → ACK Handler（BE-CMD-03/DEC-015：
 *   普通 Command ACK 与 OTA Target ACK 经 objectType + 关联 ID 隔离，见 signals/ack.ts）；
 * - 各 Handler 均实现 handled 语义（非本类型返回 handled=false），分发器按序匹配首个
 *   handled=true 的 Handler；
 * - media → Media Handler（复用 BE-MED-01 核心，并与 BE-IOT-03 receipt 同事务）；
 * - 无注册 Handler 的类型 → NO_HANDLER 隔离（Quarantine），绝不静默丢弃；
 * - Handler 抛出的 QUARANTINE IngestError 透传（由 createIngestionHandler 统一隔离）；
 *   其他异常按瞬时错误交 SQS 重试（同上）。
 *
 * 接线：createIngestionHandler({ ..., onValidated: createBusinessDispatcher(deps) })。
 */
import type { DbClient } from '@fdp/database';
import type { SecurePackageService } from '@fdp/auth';
import type { MediaObjectStorage, MediaUploadPolicyQuery } from '@fdp/media';
import { createHeartbeatHandler } from '../heartbeat/handler.js';
import { createTelemetryHandler } from '../telemetry/handler.js';
import { createReportHandler } from '../report/handler.js';
import { createAckHandler, createAlarmHandler, createEventHandler, createTamperHandler } from '../signals/index.js';
import { createMediaHandler } from '../media/handler.js';
import { quarantineError } from './errors.js';
import type { ValidatedMessage } from './pipeline.js';

export interface BusinessDispatcherDeps {
  readonly client: DbClient;
  /** Heartbeat 依赖（首次心跳的 Onboarding 完成/证书轮换确认需下载安全包）。 */
  readonly securePackage: SecurePackageService;
  readonly certificateRevoker: { revokeCertificate(certificateId: string): Promise<void> };
  readonly mediaStorage: MediaObjectStorage;
  readonly mediaUploadPolicy: MediaUploadPolicyQuery;
  readonly now?: () => Date;
}

type RouteHandler = (message: ValidatedMessage) => Promise<{ readonly handled: boolean }>;

export function createBusinessDispatcher(deps: BusinessDispatcherDeps): (message: ValidatedMessage) => Promise<void> {
  const handlers: readonly RouteHandler[] = [
    createHeartbeatHandler(deps),
    createTelemetryHandler(deps),
    createReportHandler(deps),
    createAlarmHandler(deps),
    createEventHandler(deps),
    createTamperHandler(deps),
    createAckHandler(deps),
    createMediaHandler({
      client: deps.client,
      storage: deps.mediaStorage,
      uploadPolicy: deps.mediaUploadPolicy,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  ];
  return async (message) => {
    for (const handler of handlers) {
      if ((await handler(message)).handled) return;
    }
    // 确定的异常路径：无注册 Handler 的类型进入隔离，不静默丢弃
    throw quarantineError('NO_HANDLER', 'iotType', `no handler registered for topic type ${message.envelope.iotType}`);
  };
}
