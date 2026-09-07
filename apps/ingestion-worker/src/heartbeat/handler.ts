/**
 * BE-IOT-04 Heartbeat Handler：校验后消息的 latest state 维护 + 确认扩展点分发。
 *
 * 处理链（输入为 BE-IOT-02 已校验消息）：
 * 1. BE-IOT-03 receipt 幂等：同 (deviceId, heartbeat, seq) 重复消息跳过；
 * 2. 业务写入（同事务）：data 全字段映射 device_latest_state（在线/uptime/固件/运行模式/
 *    License/网络/资源/传感器/证书/Tamper），乱序旧消息由条件更新保证不倒退；
 * 3. 扩展点（receipt 事务提交后，各自幂等）：
 *    - 设备 OnboardingApproved → completeOnboardingOnFirstHeartbeat（BE-ONB-04）；
 *    - confirmCertificateRotationOnFirstHeartbeat（BE-CERT-02/03，非轮换证书静默跳过）；
 * 4. 不进入 Raw Archive：不写 outbox 归档事件。
 *
 * 功能边界：不实现离线定时判定和运维告警。
 */
import type { DbClient } from '@fdp/database';
import type { SecurePackageService } from '@fdp/auth';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import type { ReceiptOutcome } from '../ingest/receipt.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';
import { completeOnboardingOnFirstHeartbeat } from '../onboarding-completion.js';
import { confirmCertificateRotationOnFirstHeartbeat } from '../rotation-confirmation.js';
import { applyLatestState } from './repository.js';
import type { LatestStateApplyResult } from './repository.js';

export interface HeartbeatHandlerDeps {
  readonly client: DbClient;
  readonly securePackage: SecurePackageService;
  readonly certificateRevoker: { revokeCertificate(certificateId: string): Promise<void> };
  readonly now?: () => Date;
}

export interface HeartbeatHandleResult {
  /** false 表示非 heartbeat 类型消息（分发器不应路由到此）。 */
  readonly handled: boolean;
  readonly outcome: ReceiptOutcome | undefined;
  readonly stateApplied: LatestStateApplyResult | undefined;
  readonly onboardingTransitioned: boolean;
  readonly rotationConfirmed: boolean;
}

const NOT_HANDLED: HeartbeatHandleResult = {
  handled: false,
  outcome: undefined,
  stateApplied: undefined,
  onboardingTransitioned: false,
  rotationConfirmed: false,
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** heartbeat data → device_latest_state 列映射（CT-03 Schema 已校验，缺失可选项不落列）。 */
function buildStateWrite(message: ValidatedMessage, occurredAt: Date): Record<string, unknown> {
  const data = message.data;
  const state: Record<string, unknown> = {
    connectivity: 'ONLINE', // 收到 Heartbeat 即在线（离线判定属定时任务，超出本任务边界）
    customerId: message.device.customerId,
    lastHeartbeatAt: occurredAt,
  };
  const scalarMap: Record<string, unknown> = {
    operationalStatus: asString(data.operationalStatus),
    machineRunning: asBoolean(data.machineRunning),
    machineMode: asString(data.machineMode),
    firmwareVersion: asString(data.firmwareVersion),
    licenseStatus: asString(data.licenseStatus),
    networkType: asString(data.networkType),
    networkStatus: asString(data.networkStatus),
    signalStrength: asNumber(data.signalStrength),
    cpuUsagePct: asNumber(data.cpuUsagePct),
    memoryUsagePct: asNumber(data.memoryUsagePct),
    storageUsagePct: asNumber(data.storageUsagePct),
    certificateStatus: asString(data.certificateStatus),
    tamperStatus: asString(data.tamperStatus),
    uptimeSeconds: asNumber(data.uptimeSeconds),
  };
  for (const [key, value] of Object.entries(scalarMap)) {
    if (value !== undefined) state[key] = value;
  }
  const expiry = asString(data.licenseExpiryDate);
  if (expiry) state.licenseExpiryDate = new Date(`${expiry}T00:00:00.000Z`);
  state.sensorStatus = {
    overall: asString(data.sensorOverallStatus) ?? null,
    temperature: asString(data.temperatureSensor) ?? null,
    humidity: asString(data.humiditySensor) ?? null,
    weight: asString(data.weightSensor) ?? null,
    gas: asString(data.gasSensor) ?? null,
  };
  return state;
}

export function createHeartbeatHandler(
  deps: HeartbeatHandlerDeps,
): (message: ValidatedMessage) => Promise<HeartbeatHandleResult> {
  return async (message) => {
    if (message.envelope.iotType !== 'heartbeat') return NOT_HANDLED;

    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const seq = Number(meta.seq);
    const occurredAt = new Date(message.occurredAt);
    const deviceId = message.device.deviceId;

    const processed = await processWithReceipt(deps.client, {
      key: { deviceId, topicType: 'heartbeat', seq },
      payloadHash: hashPayload(message.envelope.payload),
      receivedAtMs: message.envelope.iotReceivedAt,
      business: async (tx) => applyLatestState(tx, deviceId, buildStateWrite(message, occurredAt), occurredAt),
    });
    // receipt 仅保护 latest state；确认扩展点在事务提交后执行且自身幂等。
    // 重复消息仍须重试扩展点，避免首次调用在外部副作用失败后永久跳过。
    let onboardingTransitioned = false;
    if (message.device.lifecycleStatus === 'OnboardingApproved') {
      const completion = await completeOnboardingOnFirstHeartbeat(
        {
          client: deps.client,
          securePackage: deps.securePackage,
          certificateRevoker: deps.certificateRevoker,
          now: deps.now ?? (() => new Date()),
        },
        { deviceId, certificateFingerprint: message.device.certificateFingerprint, occurredAt },
      );
      onboardingTransitioned = completion.transitioned;
    }
    const rotation = await confirmCertificateRotationOnFirstHeartbeat(
      { client: deps.client, securePackage: deps.securePackage, now: deps.now ?? (() => new Date()) },
      { deviceId, certificateFingerprint: message.device.certificateFingerprint },
    );

    return {
      handled: true,
      outcome: processed.outcome,
      stateApplied: processed.outcome === 'DUPLICATE_SKIPPED' ? undefined : processed.result,
      onboardingTransitioned,
      rotationConfirmed: rotation.confirmed,
    };
  };
}
