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
import { createIngestionHandler } from '../src/index.js';
import type { QuarantineRecord, SqsBatchResponseLike, ValidatedMessage } from '../src/index.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const RECEIVED_AT = Date.parse('2026-08-28T02:00:00.000Z');
const TS = '2026-08-28T02:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);

let seq = 0;
/** 落库 Active 设备（挂客户）+ ACTIVE 证书。 */
async function plantDevice(options: { certificateStatus?: string; withCustomer?: boolean } = {}) {
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
      lifecycleStatus: 'Active',
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

  test('身份违规进 Quarantine：未知证书 / 非 ACTIVE 证书 / Topic 设备与证书绑定不一致', async () => {
    const registered = await plantDevice();
    const other = await plantDevice();
    const revoked = await plantDevice({ certificateStatus: 'REVOKED' });
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
      ['UNKNOWN_DEVICE', 'IDENTITY_VIOLATION', 'IDENTITY_VIOLATION'],
    );
    assert.equal(h.quarantined[2]?.errorPath, 'iotDeviceId');
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

  test('Envelope 结构违规进 Quarantine：iot* 字段缺失 / Topic 与 iotType 不一致', async () => {
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
    const response = await h.handler({
      Records: [
        { messageId: 'sqs-missing', body: missingField },
        { messageId: 'sqs-mismatch', body: topicMismatch },
      ],
    });
    assert.deepEqual(response.batchItemFailures, []);
    assert.deepEqual(
      h.quarantined.map((q) => [q.errorType, q.errorPath]),
      [
        ['INVALID_ENVELOPE', 'iotPrincipal'],
        ['INVALID_ENVELOPE', 'iotType'],
      ],
    );
  });
});
