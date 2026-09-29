/**
 * BE-IOT-02 Ingestion 通用校验管线验收（PGlite + 真实 CT-03 Schema）。
 *
 * 验收基准覆盖：
 * - 合法批次继续处理（onValidated 收到全部合法消息，无 failures/quarantine）；
 * - 单条坏消息不导致整批重复（partial failure：坏消息隔离，其余照常处理）；
 * - 非法 Schema/身份/时钟/JSON 进入 Quarantine（原文 + errorType + errorPath）；
 * - 瞬时错误（业务分发/AWS 抖动）可重试（batchItemFailures 仅含该条）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  CERTIFICATE_PACKAGE_MAX_CLAIMS,
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
  createLocalTestKeyProvider,
  SecurePackageService,
} from '@fdp/auth';
import { DEC013_LEGACY_COMPATIBILITY_ENDS_AT, computeAuditHash } from '@fdp/contracts/mqtt/payload-normalization.js';
import { createBusinessDispatcher, createIngestionHandler } from '../src/index.js';
import type { QuarantineRecord, SqsBatchResponseLike, ValidatedMessage } from '../src/index.js';
import { certificateIdFromPrincipal } from '../src/ingest/identity.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let securePackage: SecurePackageService;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  securePackage = new SecurePackageService({
    db: prisma,
    keyProvider: createLocalTestKeyProvider('p0-ingestion-runtime'),
    config: {
      retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS,
      maxClaims: CERTIFICATE_PACKAGE_MAX_CLAIMS,
    },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const RECEIVED_AT = Date.parse('2026-08-28T02:00:00.000Z');
const TS = '2026-08-28T02:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);
const mediaDispatcherDeps = {
  mediaStorage: {
    statObject: async () => null,
    computeSha256: async () => null,
  },
  mediaUploadPolicy: {
    getMediaTypes: () => ['IMAGE', 'VIDEO'],
    getMaxSizeKb: () => 204800,
    getDailyUploadQuotaPerDevice: () => 100,
    getUploadUrlTtlSeconds: () => 900,
    getDownloadUrlTtlSeconds: () => 900,
  },
} as const;

test('IoT Rule principal() 的原始证书 ID 与历史 ARN 均可解析', () => {
  const id = 'a'.repeat(64);
  assert.equal(certificateIdFromPrincipal(id), id);
  assert.equal(certificateIdFromPrincipal(`arn:aws:iot:ap-southeast-1:123456789012:cert/${id}`), id);
  assert.isNull(certificateIdFromPrincipal('not-a-certificate'));
});

let seq = 0;
/** 落库 Active 设备（挂客户）+ ACTIVE 证书。 */
async function plantDevice(
  options: { certificateStatus?: string; withCustomer?: boolean; lifecycleStatus?: string } = {},
) {
  seq += 1;
  const deviceId = `dev-ing-${seq}`;
  let customerId: string | null = null;
  if (options.withCustomer !== false) {
    const customer = await prisma.customer.create({ data: { name: `Customer ING ${seq}` } });
    customerId = customer.id;
  }
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ING-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      customerId,
    },
  });
  const certificateId = `cert-ing-${seq}`;
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: `${FINGERPRINT.slice(0, 60)}${String(seq).padStart(4, '0')}`,
      status: options.certificateStatus ?? 'ACTIVE',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    },
  });
  return { deviceId, certificateId, customerId };
}

async function plantApprovedOnboardingDevice() {
  seq += 1;
  const deviceId = `dev-ing-onboarding-${seq}`;
  const serialNumber = `SN-ING-ONBOARDING-${seq}`;
  const customer = await prisma.customer.create({ data: { name: `Customer ING Onboarding ${seq}` } });
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'OnboardingApproved',
      customerId: customer.id,
    },
  });
  const certificateId = `cert-ing-onboarding-${seq}`;
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: `${FINGERPRINT.slice(0, 60)}${String(seq).padStart(4, '0')}`,
      status: 'PENDING_CLAIM',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-12-31T00:00:00Z'),
    },
  });
  await securePackage.storePackage(certificateId, Buffer.from('{"privateKey":"test-only"}'));
  await prisma.onboardingRequest.create({
    data: {
      csrPem: 'TEST_CSR',
      publicKeyFingerprint: 'a'.repeat(64),
      serialNumber,
      submittedBy: `DEVICE:${serialNumber}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      status: 'APPROVED',
      onboardingDeadlineAt: new Date('2027-12-31T00:00:00Z'),
    },
  });
  return { deviceId, certificateId };
}

function heartbeatPayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { id, ts: TS, seq: 1, schemaVer: '1.0' },
    data: {
      deviceStatus: 'ONLINE',
      uptimeSeconds: 100,
      firmwareVersion: '1.2.3',
      operationalStatus: 'ACTIVE',
      machineRunning: true,
      machineMode: 'IDLE',
      licenseStatus: 'ACTIVE',
      networkType: '4G',
      networkStatus: 'CONNECTED',
      sensorOverallStatus: 'NORMAL',
    },
    ...overrides,
  };
}

function telemetryPayload(id: string): Record<string, unknown> {
  const payload = {
    meta: { id, ts: TS, seq: 1, schemaVer: '1.0' },
    audit: { hash: '' },
    data: { currentAmp: 3.8, humidityPct: 45.2 },
  };
  payload.audit.hash = computeAuditHash(payload);
  return payload;
}

function envelopeBody(
  payload: Record<string, unknown>,
  identity: { deviceId: string; certificateId: string; type?: string; receivedAt?: number },
): string {
  const type = identity.type ?? 'heartbeat';
  return JSON.stringify({
    ...payload,
    iotTopic: `bnx/device/${identity.deviceId}/${type}`,
    iotDeviceId: identity.deviceId,
    iotType: type,
    iotReceivedAt: identity.receivedAt ?? RECEIVED_AT,
    iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${identity.certificateId}`,
  });
}

interface Harness {
  handler: (event: { Records: { messageId: string; body: string }[] }) => Promise<SqsBatchResponseLike>;
  validated: ValidatedMessage[];
  quarantined: QuarantineRecord[];
}

function harness(onValidated?: (message: ValidatedMessage) => Promise<void>): Harness {
  const validated: ValidatedMessage[] = [];
  const quarantined: QuarantineRecord[] = [];
  const handler = createIngestionHandler({
    client: prisma,
    quarantine: {
      async send(record) {
        quarantined.push(record);
      },
    },
    onValidated:
      onValidated ??
      (async (message) => {
        validated.push(message);
      }),
  });
  return { handler, validated, quarantined };
}

describe('createIngestionHandler（BE-IOT-02 校验管线）', () => {
  test('生产组合根闭环：SQS → 身份/Schema 校验 → Heartbeat → Onboarded', async () => {
    const ctx = await plantApprovedOnboardingDevice();
    const quarantined: QuarantineRecord[] = [];
    const handler = createIngestionHandler({
      client: prisma,
      quarantine: {
        async send(record) {
          quarantined.push(record);
        },
      },
      onValidated: createBusinessDispatcher({
        client: prisma,
        securePackage,
        certificateRevoker: { revokeCertificate: async () => {} },
        ...mediaDispatcherDeps,
      }),
    });

    const response = await handler({
      Records: [
        {
          messageId: 'sqs-onboarding-heartbeat',
          body: envelopeBody(heartbeatPayload('HB-ONBOARDING-FIRST'), ctx),
        },
      ],
    });

    assert.deepEqual(response.batchItemFailures, []);
    assert.deepEqual(quarantined, []);
    assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: ctx.deviceId } })).lifecycleStatus, 'Onboarded');
    const certificate = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: ctx.certificateId } });
    assert.equal(certificate.status, 'ACTIVE');
    assert.equal(certificate.packageCiphertext, null);
  });

  test('合法批次全部继续处理：device/customer context 取自台账而非 Payload', async () => {
    const { deviceId, certificateId, customerId } = await plantDevice();
    const h = harness();
    const response = await h.handler({
      Records: [
        { messageId: 'sqs-1', body: envelopeBody(heartbeatPayload('HB-DEV001-1'), { deviceId, certificateId }) },
        { messageId: 'sqs-2', body: envelopeBody(heartbeatPayload('HB-DEV001-2'), { deviceId, certificateId }) },
      ],
    });
    assert.deepEqual(response.batchItemFailures, []);
    assert.deepEqual(h.quarantined, []);
    assert.equal(h.validated.length, 2);
    const first = h.validated[0];
    assert.ok(first);
    assert.equal(first.messageId, 'HB-DEV001-1');
    assert.equal(first.occurredAt, TS);
    assert.equal(first.device.deviceId, deviceId);
    assert.equal(first.device.customerId, customerId, 'customerId 必须取台账值');
    assert.equal(first.device.certificateId, certificateId);
    assert.equal(first.data.deviceStatus, 'ONLINE');
  });

  test('单条坏消息不导致整批重复：坏消息进 Quarantine，其余照常处理', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness();
    const response = await h.handler({
      Records: [
        { messageId: 'sqs-ok-1', body: envelopeBody(heartbeatPayload('HB-DEV002-1'), { deviceId, certificateId }) },
        { messageId: 'sqs-bad', body: '{not-json' },
        { messageId: 'sqs-ok-2', body: envelopeBody(heartbeatPayload('HB-DEV002-2'), { deviceId, certificateId }) },
      ],
    });
    assert.deepEqual(response.batchItemFailures, [], '隔离消息不得进入重试');
    assert.equal(h.validated.length, 2);
    assert.equal(h.quarantined.length, 1);
    const q = h.quarantined[0];
    assert.ok(q);
    assert.equal(q.errorType, 'INVALID_JSON');
    assert.equal(q.rawBody, '{not-json', 'Quarantine 必须保存原文');
  });

  test('Quarantine 投递失败只重试当前记录，批次后续记录继续隔离', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const quarantined: QuarantineRecord[] = [];
    let sends = 0;
    const handler = createIngestionHandler({
      client: prisma,
      quarantine: {
        async send(record) {
          sends += 1;
          if (sends === 1) throw new Error('simulated quarantine outage');
          quarantined.push(record);
        },
      },
    });
    const response = await handler({
      Records: [
        { messageId: 'sqs-quarantine-down', body: '{bad-first' },
        { messageId: 'sqs-quarantine-next', body: '{bad-second' },
        {
          messageId: 'sqs-valid-after',
          body: envelopeBody(heartbeatPayload('HB-AFTER-Q'), { deviceId, certificateId }),
        },
      ],
    });
    assert.deepEqual(response.batchItemFailures, [{ itemIdentifier: 'sqs-quarantine-down' }]);
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0]?.rawBody, '{bad-second');
  });

  test('Schema 违规进 Quarantine（含错误路径）；字段范围由 Schema 覆盖', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness();
    const badPayload = heartbeatPayload('HB-DEV003-1');
    (badPayload.data as Record<string, unknown>).deviceStatus = 'BROKEN';
    const badEnum = envelopeBody(badPayload, { deviceId, certificateId });
    const response = await h.handler({ Records: [{ messageId: 'sqs-1', body: badEnum }] });
    assert.deepEqual(response.batchItemFailures, []);
    assert.equal(h.validated.length, 0);
    assert.equal(h.quarantined.length, 1);
    const q = h.quarantined[0];
    assert.ok(q);
    assert.equal(q.errorType, 'SCHEMA_VIOLATION');
    assert.include(q.errorPath, 'deviceStatus');
    assert.equal(q.iotDeviceId, deviceId);
    assert.equal(q.iotTopic, `bnx/device/${deviceId}/heartbeat`);
  });

  test('DEC-013：兼容期内 Heartbeat 旧嵌套结构转换为正式扁平字段', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness();
    const payload = heartbeatPayload('HB-LEGACY-1');
    const data = payload.data as Record<string, unknown>;
    delete data.machineRunning;
    delete data.machineMode;
    delete data.networkType;
    delete data.networkStatus;
    delete data.sensorOverallStatus;
    data.machine = { running: true, currentMode: 'DISCHARING' };
    data.network = { type: '4G', status: 'CONNECTED' };
    data.sensorStatus = { overall: 'NORMAL' };
    const rawBody = envelopeBody(payload, { deviceId, certificateId });
    const response = await h.handler({ Records: [{ messageId: 'sqs-legacy', body: rawBody }] });
    assert.deepEqual(response.batchItemFailures, []);
    assert.deepEqual(h.quarantined, []);
    assert.equal(h.validated[0]?.data.machineMode, 'DISCHARGING');
    assert.equal(h.validated[0]?.data.networkType, '4G');
    assert.equal(h.validated[0]?.data.sensorOverallStatus, 'NORMAL');
    assert.equal(h.validated[0]?.rawBody, rawBody);
    const rawData = h.validated[0]?.rawPayload.data as Record<string, unknown>;
    assert.deepEqual(rawData.machine, { running: true, currentMode: 'DISCHARING' });
    assert.isUndefined(rawData.machineMode);
    assert.equal((h.validated[0]?.normalizedPayload.data as Record<string, unknown>).machineMode, 'DISCHARGING');
    assert.isTrue(Object.isFrozen(h.validated[0]?.rawPayload));
    assert.isTrue(Object.isFrozen(rawData));
  });

  test('Telemetry 业务使用 normalized，Raw Archive 保留未规范化 Payload 与原始 Body', async () => {
    const ctx = await plantDevice();
    const payload = telemetryPayload('TEL-RAW-NORMALIZED-1');
    const data = payload.data as Record<string, unknown>;
    const currentAmp = data.currentAmp;
    delete data.currentAmp;
    data.motorCurrentAmp = currentAmp;
    (payload.audit as Record<string, unknown>).hash = computeAuditHash(payload);
    const rawBody = envelopeBody(payload, { ...ctx, type: 'telemetry' });
    const quarantined: QuarantineRecord[] = [];
    const handler = createIngestionHandler({
      client: prisma,
      quarantine: {
        async send(record) {
          quarantined.push(record);
        },
      },
      onValidated: createBusinessDispatcher({
        client: prisma,
        securePackage,
        certificateRevoker: { revokeCertificate: async () => {} },
        ...mediaDispatcherDeps,
      }),
    });
    const response = await handler({ Records: [{ messageId: 'sqs-raw-normalized', body: rawBody }] });
    assert.deepEqual(response.batchItemFailures, []);
    assert.deepEqual(quarantined, []);
    const aggregate = await prisma.telemetryHourly.findFirstOrThrow({ where: { deviceId: ctx.deviceId } });
    assert.equal((aggregate.metrics as Record<string, { avg: number }>).currentAmp?.avg, currentAmp);
    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: ctx.deviceId, eventType: 'ARCHIVE' },
    });
    const archive = outbox.payload as Record<string, unknown>;
    assert.equal(archive.rawBody, rawBody);
    const archivedData = (archive.payload as Record<string, unknown>).data as Record<string, unknown>;
    assert.equal(archivedData.motorCurrentAmp, currentAmp);
    assert.isUndefined(archivedData.currentAmp);
    assert.equal(archive.auditHash, computeAuditHash(payload));
  });

  test('DEC-013：兼容截止边界起旧格式进入 Quarantine', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness();
    const payload = heartbeatPayload('HB-LEGACY-EXPIRED');
    (payload.data as Record<string, unknown>).machineMode = 'DISCHARING';
    await h.handler({
      Records: [
        {
          messageId: 'sqs-expired',
          body: envelopeBody(payload, {
            deviceId,
            certificateId,
            receivedAt: Date.parse(DEC013_LEGACY_COMPATIBILITY_ENDS_AT),
          }),
        },
      ],
    });
    assert.equal(h.quarantined[0]?.errorType, 'SCHEMA_VIOLATION');
    assert.equal(h.quarantined[0]?.errorPath, 'data');
    assert.include(h.quarantined[0]?.reason ?? '', 'LEGACY_FORMAT_EXPIRED');
  });

  test('DEC-013：Audited Topic 验证 RFC 8785 audit.hash，不匹配时隔离', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness();
    const valid = telemetryPayload('TEL-AUDIT-1');
    const invalid = telemetryPayload('TEL-AUDIT-2');
    (invalid.audit as Record<string, unknown>).hash = '0'.repeat(64);
    await h.handler({
      Records: [
        {
          messageId: 'sqs-audit-ok',
          body: envelopeBody(valid, { deviceId, certificateId, type: 'telemetry' }),
        },
        {
          messageId: 'sqs-audit-bad',
          body: envelopeBody(invalid, { deviceId, certificateId, type: 'telemetry' }),
        },
      ],
    });
    assert.equal(h.validated.length, 1);
    assert.equal(h.quarantined.length, 1);
    assert.equal(h.quarantined[0]?.errorType, 'AUDIT_HASH_MISMATCH');
    assert.equal(h.quarantined[0]?.errorPath, 'audit.hash');
  });

  test('身份违规进 Quarantine：未知/撤销证书、非审批态 PENDING_CLAIM、Topic 绑定不一致', async () => {
    const registered = await plantDevice();
    const other = await plantDevice();
    const revoked = await plantDevice({ certificateStatus: 'REVOKED' });
    const unapprovedPending = await plantDevice({ certificateStatus: 'PENDING_CLAIM' });
    const h = harness();
    const response = await h.handler({
      Records: [
        {
          messageId: 'sqs-unknown',
          body: envelopeBody(heartbeatPayload('HB-DEV004-1'), {
            deviceId: registered.deviceId,
            certificateId: 'cert-ing-not-exist',
          }),
        },
        {
          messageId: 'sqs-revoked',
          body: envelopeBody(heartbeatPayload('HB-DEV004-2'), {
            deviceId: revoked.deviceId,
            certificateId: revoked.certificateId,
          }),
        },
        {
          messageId: 'sqs-unapproved-pending',
          body: envelopeBody(heartbeatPayload('HB-DEV004-PENDING'), {
            deviceId: unapprovedPending.deviceId,
            certificateId: unapprovedPending.certificateId,
          }),
        },
        {
          messageId: 'sqs-mismatch',
          body: envelopeBody(heartbeatPayload('HB-DEV004-3'), {
            deviceId: other.deviceId,
            certificateId: registered.certificateId,
          }),
        },
      ],
    });
    assert.deepEqual(response.batchItemFailures, []);
    assert.equal(h.validated.length, 0);
    assert.deepEqual(
      h.quarantined.map((q) => q.errorType),
      ['UNKNOWN_DEVICE', 'IDENTITY_VIOLATION', 'IDENTITY_VIOLATION', 'IDENTITY_VIOLATION'],
    );
    assert.equal(h.quarantined[3]?.errorPath, 'iotDeviceId');
  });

  test('Retired 设备即使证书仍 ACTIVE，八类业务 MQTT 也全部失败关闭', async () => {
    const retired = await plantDevice({ lifecycleStatus: 'Retired' });
    const topicTypes = ['heartbeat', 'telemetry', 'report', 'alarm', 'event', 'ack', 'tamper', 'media'];
    const h = harness();
    await h.handler({
      Records: topicTypes.map((type) => ({
        messageId: `sqs-retired-${type}`,
        body: envelopeBody(heartbeatPayload(`RETIRED-${type}`), { ...retired, type }),
      })),
    });
    assert.equal(h.validated.length, 0);
    assert.equal(h.quarantined.length, topicTypes.length);
    assert.deepEqual(
      h.quarantined.map((item) => [item.errorType, item.errorPath]),
      topicTypes.map(() => ['IDENTITY_VIOLATION', 'iotDeviceId']),
    );
  });

  test('时钟偏差超阈值进 Quarantine（CLOCK_SKEW，路径 meta.ts）', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness();
    const skewed = heartbeatPayload('HB-DEV005-1');
    (skewed.meta as Record<string, unknown>).ts = '2026-08-28T01:00:00.000Z'; // 偏差 3600s > 300s
    const response = await h.handler({
      Records: [{ messageId: 'sqs-1', body: envelopeBody(skewed, { deviceId, certificateId }) }],
    });
    assert.deepEqual(response.batchItemFailures, []);
    assert.equal(h.quarantined.length, 1);
    assert.equal(h.quarantined[0]?.errorType, 'CLOCK_SKEW');
    assert.equal(h.quarantined[0]?.errorPath, 'meta.ts');
  });

  test('瞬时错误可重试：仅失败条进入 batchItemFailures，其余正常处理', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness(async (message) => {
      if (message.messageId === 'HB-DEV006-FLAKY') {
        throw new Error('simulated downstream timeout'); // 非 IngestError → 瞬时
      }
    });
    const response = await h.handler({
      Records: [
        {
          messageId: 'sqs-flaky',
          body: envelopeBody(heartbeatPayload('HB-DEV006-FLAKY'), { deviceId, certificateId }),
        },
        { messageId: 'sqs-ok', body: envelopeBody(heartbeatPayload('HB-DEV006-OK'), { deviceId, certificateId }) },
      ],
    });
    assert.deepEqual(response.batchItemFailures, [{ itemIdentifier: 'sqs-flaky' }]);
    assert.deepEqual(h.quarantined, []);
  });

  test('Envelope 失败关闭：字段缺失、Topic 上下文不一致及额外 iot* 字段均隔离', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const h = harness();
    const missingField = JSON.stringify({
      ...heartbeatPayload('HB-DEV007-1'),
      iotTopic: `bnx/device/${deviceId}/heartbeat`,
      iotDeviceId: deviceId,
      iotType: 'heartbeat',
      iotReceivedAt: RECEIVED_AT,
      // iotPrincipal 缺失
    });
    const topicMismatch = JSON.stringify({
      ...heartbeatPayload('HB-DEV007-2'),
      iotTopic: `bnx/device/${deviceId}/telemetry`,
      iotDeviceId: deviceId,
      iotType: 'heartbeat',
      iotReceivedAt: RECEIVED_AT,
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${certificateId}`,
    });
    const deviceMismatch = JSON.stringify({
      ...heartbeatPayload('HB-DEV007-3'),
      iotTopic: `bnx/device/${deviceId}/heartbeat`,
      iotDeviceId: 'different-device',
      iotType: 'heartbeat',
      iotReceivedAt: RECEIVED_AT,
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${certificateId}`,
    });
    const extraIotField = JSON.stringify({
      ...heartbeatPayload('HB-DEV007-4'),
      iotTopic: `bnx/device/${deviceId}/heartbeat`,
      iotDeviceId: deviceId,
      iotType: 'heartbeat',
      iotReceivedAt: RECEIVED_AT,
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${certificateId}`,
      iotSpoofedContext: 'must-not-be-silently-dropped',
    });
    const response = await h.handler({
      Records: [
        { messageId: 'sqs-missing', body: missingField },
        { messageId: 'sqs-mismatch', body: topicMismatch },
        { messageId: 'sqs-device-mismatch', body: deviceMismatch },
        { messageId: 'sqs-extra-iot', body: extraIotField },
      ],
    });
    assert.deepEqual(response.batchItemFailures, []);
    assert.deepEqual(
      h.quarantined.map((q) => [q.errorType, q.errorPath]),
      [
        ['INVALID_ENVELOPE', 'iotPrincipal'],
        ['INVALID_ENVELOPE', 'iotType'],
        ['INVALID_ENVELOPE', 'iotDeviceId'],
        ['SCHEMA_VIOLATION', '(root)'],
      ],
    );
  });
});
