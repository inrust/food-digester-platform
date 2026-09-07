/**
 * BE-IOT-04 Heartbeat Handler 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 新消息覆盖旧状态（全字段映射：在线/uptime/固件/运行模式/License/网络/资源/传感器/证书/Tamper）；
 * - 乱序旧 Heartbeat 不倒退最新状态；
 * - 不生成原始归档事件（outbox 无 ARCHIVE 记录）；
 * - 触发 Onboarding / 证书轮换确认扩展点（BE-ONB-04 / BE-CERT-02/03）；
 * - 重复 Heartbeat 幂等跳过（BE-IOT-03 receipt）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
  certificateFingerprintFromPem,
  createLocalTestKeyProvider,
  SecurePackageService,
} from '@fdp/auth';
import { createHeartbeatHandler } from '../src/index.js';
import type { ValidatedMessage } from '../src/index.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';

const NOW = new Date('2026-08-28T08:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let securePackage: SecurePackageService;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  securePackage = new SecurePackageService({
    db: prisma,
    keyProvider: createLocalTestKeyProvider('be-iot-04'),
    config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: 1, now },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function fixturePem(seed: string): string {
  const body = Buffer.from(`hb-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

let seqCounter = 0;
/** 落库设备 + 证书；返回 handler 所需的上下文。 */
async function plantDevice(
  options: {
    lifecycleStatus?: string;
    certificateStatus?: string;
    withPackage?: boolean;
  } = {},
) {
  seqCounter += 1;
  const deviceId = `dev-hb-${seqCounter}`;
  const customer = await prisma.customer.create({ data: { name: `Customer HB ${seqCounter}` } });
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-HB-${seqCounter}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      customerId: customer.id,
    },
  });
  const certificateId = `cert-hb-${seqCounter}`;
  const pem = fixturePem(`${seqCounter}`);
  const fingerprint = certificateFingerprintFromPem(pem);
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint,
      status: options.certificateStatus ?? 'ACTIVE',
      notBefore: new Date(NOW.getTime() - 30 * DAY_MS),
      notAfter: new Date(NOW.getTime() + 200 * DAY_MS),
    },
  });
  if (options.withPackage) await securePackage.storePackage(certificateId, Buffer.from('{}'));
  if ((options.lifecycleStatus ?? 'Active') === 'OnboardingApproved') {
    const token = await prisma.onboardingToken.create({
      data: {
        tokenHash: `token-heartbeat-${seqCounter}`,
        serialNumber: `SN-HB-${seqCounter}`,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      },
    });
    await prisma.onboardingRequest.create({
      data: {
        tokenId: token.id,
        serialNumber: `SN-HB-${seqCounter}`,
        model: 'BNX-100',
        hardwareVersion: 'HW1.0',
        manufacturer: 'Hiddenjoy',
        manufactureDate: new Date('2026-01-01T00:00:00Z'),
        status: 'APPROVED',
        onboardingDeadlineAt: new Date(NOW.getTime() + DAY_MS),
      },
    });
  }
  return { deviceId, customerId: customer.id, certificateId, fingerprint };
}

function heartbeatData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceStatus: 'ONLINE',
    uptimeSeconds: 3600,
    firmwareVersion: '1.2.3',
    operationalStatus: 'ACTIVE',
    machineRunning: true,
    machineMode: 'PROCESSING',
    licenseStatus: 'ACTIVE',
    licenseExpiryDate: '2027-01-31',
    networkType: '4G',
    networkStatus: 'CONNECTED',
    signalStrength: -75,
    cpuUsagePct: 42.5,
    memoryUsagePct: 55,
    storageUsagePct: 30,
    sensorOverallStatus: 'NORMAL',
    temperatureSensor: 'NORMAL',
    humiditySensor: 'WARNING',
    weightSensor: 'NORMAL',
    gasSensor: 'NORMAL',
    certificateStatus: 'VALID',
    tamperStatus: 'NORMAL',
    ...overrides,
  };
}

function heartbeatMessage(
  ctx: { deviceId: string; customerId: string; certificateId: string; fingerprint: string },
  options: { seq: number; ts: string; lifecycleStatus?: string; data?: Record<string, unknown> },
): ValidatedMessage {
  const payload = {
    meta: { id: `HB-${ctx.deviceId}-${options.seq}`, ts: options.ts, seq: options.seq, schemaVer: '1.0' },
    data: heartbeatData(options.data),
  };
  return {
    envelope: {
      iotTopic: `bnx/device/${ctx.deviceId}/heartbeat`,
      iotDeviceId: ctx.deviceId,
      iotType: 'heartbeat',
      iotReceivedAt: Date.parse(options.ts),
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${ctx.certificateId}`,
      payload,
    },
    rawBody: JSON.stringify(payload),
    rawPayload: payload,
    normalizedPayload: payload,
    device: {
      deviceId: ctx.deviceId,
      customerId: ctx.customerId,
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      certificateId: ctx.certificateId,
      certificateFingerprint: ctx.fingerprint,
    },
    messageId: `HB-${ctx.deviceId}-${options.seq}`,
    occurredAt: options.ts,
    data: payload.data,
    audit: null,
  };
}

function handler() {
  return createHeartbeatHandler({
    client: prisma,
    securePackage,
    certificateRevoker: { revokeCertificate: async () => {} },
    now,
  });
}

describe('createHeartbeatHandler（BE-IOT-04）', () => {
  test('首次 Heartbeat：latest state 全字段落库（在线/uptime/固件/运行模式/License/网络/资源/传感器/证书/Tamper）', async () => {
    const ctx = await plantDevice();
    const result = await handler()(heartbeatMessage(ctx, { seq: 1, ts: '2026-08-28T07:55:00.000Z' }));
    assert.isTrue(result.handled);
    assert.equal(result.outcome, 'PROCESSED');
    assert.equal(result.stateApplied, 'created');

    const state = await prisma.deviceLatestState.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.ok(state);
    assert.equal(state.connectivity, 'ONLINE');
    assert.equal(state.customerId, ctx.customerId);
    assert.equal(state.operationalStatus, 'ACTIVE');
    assert.isTrue(state.machineRunning);
    assert.equal(state.machineMode, 'PROCESSING');
    assert.equal(state.firmwareVersion, '1.2.3');
    assert.equal(state.licenseStatus, 'ACTIVE');
    assert.equal(state.licenseExpiryDate?.toISOString(), '2027-01-31T00:00:00.000Z');
    assert.equal(state.networkType, '4G');
    assert.equal(state.networkStatus, 'CONNECTED');
    assert.equal(state.signalStrength, -75);
    assert.equal(Number(state.cpuUsagePct), 42.5);
    assert.equal(Number(state.memoryUsagePct), 55);
    assert.equal(Number(state.storageUsagePct), 30);
    assert.deepEqual(state.sensorStatus, {
      overall: 'NORMAL',
      temperature: 'NORMAL',
      humidity: 'WARNING',
      weight: 'NORMAL',
      gas: 'NORMAL',
    });
    assert.equal(state.certificateStatus, 'VALID');
    assert.equal(state.tamperStatus, 'NORMAL');
    assert.equal(state.uptimeSeconds, 3600);
    assert.equal(state.lastHeartbeatAt?.toISOString(), '2026-08-28T07:55:00.000Z');
  });

  test('新消息覆盖旧状态；乱序旧 Heartbeat 不倒退；重复消息幂等跳过；不产生归档事件', async () => {
    const ctx = await plantDevice();
    const handle = handler();

    const first = await handle(heartbeatMessage(ctx, { seq: 10, ts: '2026-08-28T07:50:00.000Z' }));
    assert.equal(first.stateApplied, 'created');

    // 新消息覆盖旧状态
    const newer = await handle(
      heartbeatMessage(ctx, {
        seq: 11,
        ts: '2026-08-28T07:55:00.000Z',
        data: { firmwareVersion: '2.0.0', machineMode: 'HEATING' },
      }),
    );
    assert.equal(newer.stateApplied, 'updated');
    let state = await prisma.deviceLatestState.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.equal(state?.firmwareVersion, '2.0.0');
    assert.equal(state?.machineMode, 'HEATING');
    assert.equal(state?.lastHeartbeatAt?.toISOString(), '2026-08-28T07:55:00.000Z');

    // 乱序旧 Heartbeat（seq 9 晚到，ts 更旧）→ 不倒退
    const stale = await handle(
      heartbeatMessage(ctx, { seq: 9, ts: '2026-08-28T07:45:00.000Z', data: { firmwareVersion: '0.9.0' } }),
    );
    assert.equal(stale.outcome, 'PROCESSED', '乱序消息仍计入 receipt（缺口检测）');
    assert.equal(stale.stateApplied, 'stale');
    state = await prisma.deviceLatestState.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.equal(state?.firmwareVersion, '2.0.0', '乱序旧消息不得覆盖最新状态');
    assert.equal(state?.lastHeartbeatAt?.toISOString(), '2026-08-28T07:55:00.000Z');

    // 重复消息（同 seq 同 Payload）→ 幂等跳过
    const duplicate = await handle(
      heartbeatMessage(ctx, {
        seq: 11,
        ts: '2026-08-28T07:55:00.000Z',
        data: { firmwareVersion: '2.0.0', machineMode: 'HEATING' },
      }),
    );
    assert.equal(duplicate.outcome, 'DUPLICATE_SKIPPED');
    assert.isUndefined(duplicate.stateApplied);

    // 不进入 Raw Archive：无 ARCHIVE outbox 事件
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId, eventType: 'ARCHIVE' } }), 0);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 0);
  });

  test('扩展点：OnboardingApproved 设备首个 Heartbeat 完成 Onboarding（BE-ONB-04）', async () => {
    const ctx = await plantDevice({
      lifecycleStatus: 'OnboardingApproved',
      certificateStatus: 'PENDING_CLAIM',
      withPackage: true,
    });
    const result = await handler()(
      heartbeatMessage(ctx, { seq: 1, ts: '2026-08-28T07:55:00.000Z', lifecycleStatus: 'OnboardingApproved' }),
    );
    assert.isTrue(result.onboardingTransitioned);

    const device = await prisma.device.findFirst({ where: { id: ctx.deviceId } });
    assert.equal(device?.lifecycleStatus, 'Onboarded');
    const cert = await prisma.deviceCertificate.findFirst({ where: { id: ctx.certificateId } });
    assert.equal(cert?.status, 'ACTIVE');
    assert.equal(cert?.packageCiphertext, null, '证书包必须销毁');

    // 第二个 Heartbeat（已 Onboarded）：静默幂等，不再触发迁移
    const second = await handler()(
      heartbeatMessage(ctx, { seq: 2, ts: '2026-08-28T07:56:00.000Z', lifecycleStatus: 'Onboarded' }),
    );
    assert.isFalse(second.onboardingTransitioned);
    assert.equal(second.stateApplied, 'updated');
  });

  test('首次心跳副作用失败后，同一 receipt 重试仍可完成 Onboarding', async () => {
    const ctx = await plantDevice({
      lifecycleStatus: 'OnboardingApproved',
      certificateStatus: 'PENDING_CLAIM',
      withPackage: true,
    });
    let destroyAttempts = 0;
    const flakySecurePackage = {
      async destroyPackage(certificateId: string, client: Parameters<SecurePackageService['destroyPackage']>[1]) {
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error('simulated package store outage');
        return securePackage.destroyPackage(certificateId, client);
      },
    } as SecurePackageService;
    const handle = createHeartbeatHandler({
      client: prisma,
      securePackage: flakySecurePackage,
      certificateRevoker: { revokeCertificate: async () => {} },
      now,
    });
    const message = heartbeatMessage(ctx, {
      seq: 20,
      ts: '2026-08-28T07:57:00.000Z',
      lifecycleStatus: 'OnboardingApproved',
    });

    try {
      await handle(message);
      assert.fail('首次副作用失败应向 SQS 暴露为可重试异常');
    } catch (error) {
      assert.match((error as Error).message, /simulated package store outage/);
    }
    assert.equal(
      (await prisma.device.findUniqueOrThrow({ where: { id: ctx.deviceId } })).lifecycleStatus,
      'OnboardingApproved',
    );
    const retry = await handle(message);
    assert.equal(retry.outcome, 'DUPLICATE_SKIPPED');
    assert.isTrue(retry.onboardingTransitioned);
    assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: ctx.deviceId } })).lifecycleStatus, 'Onboarded');
    assert.equal(destroyAttempts, 2);
  });

  test('扩展点：轮换新证书首个 Heartbeat 确认轮换（BE-CERT-02/03）', async () => {
    const ctx = await plantDevice();
    // 轮换窗口：新证书 ACTIVE + rotatedFromId=旧证 + 证书包 + PENDING 轮换请求
    const newCertificateId = `cert-hb-new-${ctx.deviceId}`;
    const newPem = fixturePem(`new-${ctx.deviceId}`);
    const newFingerprint = certificateFingerprintFromPem(newPem);
    await prisma.deviceCertificate.create({
      data: {
        id: newCertificateId,
        deviceId: ctx.deviceId,
        fingerprint: newFingerprint,
        status: 'ACTIVE',
        rotatedFromId: ctx.certificateId,
        notBefore: NOW,
        notAfter: new Date(NOW.getTime() + 365 * DAY_MS),
      },
    });
    await securePackage.storePackage(newCertificateId, Buffer.from('{}'));
    await prisma.certificateRotationRequest.create({
      data: {
        deviceId: ctx.deviceId,
        certificateId: ctx.certificateId,
        status: 'PENDING',
        requestedBy: 'admin-1',
        notifiedAt: NOW,
      },
    });

    const result = await handler()(
      heartbeatMessage(
        { ...ctx, certificateId: newCertificateId, fingerprint: newFingerprint },
        { seq: 1, ts: '2026-08-28T07:55:00.000Z' },
      ),
    );
    assert.isTrue(result.rotationConfirmed);

    const oldCert = await prisma.deviceCertificate.findFirst({ where: { id: ctx.certificateId } });
    assert.equal(oldCert?.status, 'REVOKED');
    const newCert = await prisma.deviceCertificate.findFirst({ where: { id: newCertificateId } });
    assert.equal(newCert?.packageCiphertext, null, '新证书包必须销毁');
    const request = await prisma.certificateRotationRequest.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.equal(request?.status, 'COMPLETED');

    // 后续普通 Heartbeat：不再确认（静默幂等）
    const later = await handler()(
      heartbeatMessage(
        { ...ctx, certificateId: newCertificateId, fingerprint: newFingerprint },
        { seq: 2, ts: '2026-08-28T07:56:00.000Z' },
      ),
    );
    assert.isFalse(later.rotationConfirmed);
  });

  test('非 heartbeat 消息不处理（分发保护）', async () => {
    const ctx = await plantDevice();
    const message = heartbeatMessage(ctx, { seq: 1, ts: '2026-08-28T07:55:00.000Z' });
    const telemetry = {
      ...message,
      envelope: { ...message.envelope, iotType: 'telemetry', iotTopic: `bnx/device/${ctx.deviceId}/telemetry` },
    };
    const result = await handler()(telemetry);
    assert.isFalse(result.handled);
    assert.equal(await prisma.deviceLatestState.count({ where: { deviceId: ctx.deviceId } }), 0);
  });
});
