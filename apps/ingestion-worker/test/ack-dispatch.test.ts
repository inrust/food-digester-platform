/**
 * BE-IOT-08 ACK Handler 分发接线验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 覆盖（在 signals-ack.test.ts 单元验收之上的增量——端到端分发链路）：
 * - 生产接线：createIngestionHandler.onValidated = createBusinessDispatcher，
 *   SQS ack 记录经校验管线 → 分发器 → ACK Handler，命令按 commandId 更新结果/执行时长；
 * - 重复 ACK 幂等：全链路同 seq 重放 → DUPLICATE_SKIPPED，command_acks 不重复落行；
 * - 冲突/未知 ACK 进入确定异常路径：Quarantine（COMMAND_MISMATCH/UNKNOWN_COMMAND），
 *   不进入 batchItemFailures，不误更新其他命令；
 * - DEC-015 隔离：OTA_TARGET ACK 经同一分发器只更新 OTA 状态与历史，不回改 Command；
 *   COMMAND ACK 混入 OTA 字段 → 隔离；
 * - 无注册 Handler 的类型（media）→ NO_HANDLER 隔离（确定异常路径，不静默丢弃）；
 * - 路由表工作：heartbeat 经分发器落 device_latest_state。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { SecurePackageService } from '@fdp/auth';
import { IngestError, createBusinessDispatcher, createIngestionHandler } from '../src/index.js';
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

const TS = '2026-08-31T11:00:00.000Z';
const RECEIVED_AT = Date.parse(TS);

/** Active 设备不触发安全包下载；Stub 仅满足依赖注入。 */
const securePackageStub = {} as SecurePackageService;

let seq = 0;

async function plantDeviceWithCommand(options: { status?: string; command?: string } = {}) {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `ACKDISP ${seq}` } });
  const deviceId = `dev-ackd-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ACKD-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  const certificateId = `cert-ackd-${seq}`;
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: 'b'.repeat(60) + String(seq).padStart(4, '0'),
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    },
  });
  const commandId = `CMD-ACKD-${seq}`;
  await prisma.deviceCommand.create({
    data: {
      id: commandId,
      deviceId,
      customerId: customer.id,
      command: options.command ?? 'STOP',
      category: 'MACHINE',
      status: options.status ?? 'PUBLISHED',
      requestedBy: 'op-1',
      requestTime: new Date('2026-08-31T10:59:00.000Z'),
      timeoutSec: 120,
      expiresAt: new Date('2026-08-31T11:01:00.000Z'),
    },
  });
  return { deviceId, certificateId, customerId: customer.id as string, commandId };
}

function envelopeBody(
  type: string,
  payload: Record<string, unknown>,
  identity: { deviceId: string; certificateId: string },
): string {
  return JSON.stringify({
    ...payload,
    iotTopic: `bnx/device/${identity.deviceId}/${type}`,
    iotDeviceId: identity.deviceId,
    iotType: type,
    iotReceivedAt: RECEIVED_AT,
    iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${identity.certificateId}`,
  });
}

function ackPayload(id: string, msgSeq: number, data: Record<string, unknown>): Record<string, unknown> {
  return { meta: { id, ts: TS, seq: msgSeq }, data };
}

interface Harness {
  handler: (event: { Records: { messageId: string; body: string }[] }) => Promise<SqsBatchResponseLike>;
  quarantined: QuarantineRecord[];
}

function harness(): Harness {
  const quarantined: QuarantineRecord[] = [];
  const handler = createIngestionHandler({
    client: prisma,
    quarantine: {
      async send(record) {
        quarantined.push(record);
      },
    },
    onValidated: createBusinessDispatcher({ client: prisma, securePackage: securePackageStub }),
  });
  return { handler, quarantined };
}

describe('BE-IOT-08 端到端分发：SQS → 管线 → 分发器 → ACK Handler', () => {
  test('COMMAND ACK 按 commandId 更新结果/执行时长；无 batchItemFailures', async () => {
    const ctx = await plantDeviceWithCommand({ status: 'PUBLISHED' });
    const h = harness();
    const body = envelopeBody(
      'ack',
      ackPayload('ACK-E2E-1', 1, {
        objectType: 'COMMAND',
        commandId: ctx.commandId,
        command: 'STOP',
        result: 'SUCCESS',
        executeTimeMs: 420,
      }),
      ctx,
    );
    const res = await h.handler({ Records: [{ messageId: 'sqs-ack-1', body }] });
    assert.deepEqual(res.batchItemFailures, []);
    assert.deepEqual(h.quarantined, []);

    const command = await prisma.deviceCommand.findUnique({ where: { id: ctx.commandId } });
    assert.equal(command?.status, 'SUCCEEDED');
    const acks = await prisma.commandAck.findMany({ where: { commandId: ctx.commandId } });
    assert.equal(acks.length, 1);
    assert.equal(acks[0]?.result, 'SUCCESS');
    assert.equal(acks[0]?.executeTimeMs, 420);
  });

  test('重复 ACK 幂等：全链路同 seq 重放 → 隔离区无记录、command_acks 仅一行', async () => {
    const ctx = await plantDeviceWithCommand({ status: 'PUBLISHED' });
    const h = harness();
    const body = envelopeBody(
      'ack',
      ackPayload('ACK-E2E-DUP-1', 7, { objectType: 'COMMAND', commandId: ctx.commandId, command: 'STOP' }),
      ctx,
    );
    const event = { Records: [{ messageId: 'sqs-dup-1', body }] };
    await h.handler(event);
    await h.handler({ Records: [{ messageId: 'sqs-dup-2', body }] }); // 同 payload 同 seq 重放
    const acks = await prisma.commandAck.findMany({ where: { commandId: ctx.commandId } });
    assert.equal(acks.length, 1);
    assert.deepEqual(h.quarantined, []);
  });

  test('未知/冲突 ACK → 确定异常路径（Quarantine），不误更新其他命令', async () => {
    const mine = await plantDeviceWithCommand({ status: 'PUBLISHED', command: 'STOP' });
    const other = await plantDeviceWithCommand({ status: 'PUBLISHED', command: 'START' });
    const h = harness();

    // 未知 commandId
    const unknown = await h.handler({
      Records: [
        {
          messageId: 'sqs-unk',
          body: envelopeBody(
            'ack',
            ackPayload('ACK-E2E-UNK', 1, { objectType: 'COMMAND', commandId: 'CMD-GHOST', command: 'STOP' }),
            mine,
          ),
        },
      ],
    });
    // command 与原命令不符（ mine 的命令是 STOP，回执声称 START ）
    const mismatch = await h.handler({
      Records: [
        {
          messageId: 'sqs-mis',
          body: envelopeBody(
            'ack',
            ackPayload('ACK-E2E-MIS', 2, {
              objectType: 'COMMAND',
              commandId: mine.commandId,
              command: 'START',
              result: 'SUCCESS',
            }),
            mine,
          ),
        },
      ],
    });
    assert.deepEqual(unknown.batchItemFailures, []);
    assert.deepEqual(mismatch.batchItemFailures, []);
    const errorTypes = h.quarantined.map((q) => q.errorType);
    assert.ok(errorTypes.includes('UNKNOWN_COMMAND'));
    assert.ok(errorTypes.includes('COMMAND_MISMATCH'));

    // 两条命令均未被误更新、无误落 ack
    assert.equal((await prisma.deviceCommand.findUnique({ where: { id: mine.commandId } }))?.status, 'PUBLISHED');
    assert.equal((await prisma.deviceCommand.findUnique({ where: { id: other.commandId } }))?.status, 'PUBLISHED');
    assert.equal(await prisma.commandAck.count({ where: { commandId: { in: [mine.commandId, other.commandId] } } }), 0);
  });

  test('DEC-015 隔离：OTA_TARGET ACK 只更新 OTA 状态与历史，不回改 Command；COMMAND 混入 OTA 字段 → 隔离', async () => {
    const ctx = await plantDeviceWithCommand({ status: 'PUBLISHED' });
    // 同设备一个 OTA Target（NOTIFIED）
    const pkg = await prisma.firmwarePackage.create({
      data: {
        id: `PKG-ACKD-${seq}`,
        version: 'FW-9.9',
        model: 'BNX-100',
        packageType: 'FULL',
        sha256: 'c'.repeat(60) + String(seq).padStart(4, '0'),
        sizeBytes: 1024,
        s3Key: `ota/${seq}/pkg.bin`,
        status: 'VERIFIED',
        uploadedBy: 'op-1',
      },
    });
    const campaign = await prisma.otaCampaign.create({
      data: {
        id: `CMP-ACKD-${seq}`,
        name: `CAMP-${seq}`,
        packageId: pkg.id,
        targetModel: 'BNX-100',
        status: 'RUNNING',
        createdBy: 'op-1',
      },
    });
    const target = await prisma.otaTarget.create({
      data: {
        id: `TGT-ACKD-${seq}`,
        campaignId: campaign.id,
        deviceId: ctx.deviceId,
        batchNo: 1,
        status: 'NOTIFIED',
      },
    });
    const h = harness();

    // OTA_TARGET ACK（DOWNLOADING）
    const otaRes = await h.handler({
      Records: [
        {
          messageId: 'sqs-ota-1',
          body: envelopeBody(
            'ack',
            ackPayload('ACK-E2E-OTA-1', 11, {
              objectType: 'OTA_TARGET',
              otaTargetId: target.id,
              status: 'DOWNLOADING',
            }),
            ctx,
          ),
        },
      ],
    });
    assert.deepEqual(otaRes.batchItemFailures, []);
    assert.deepEqual(h.quarantined, []);
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: target.id } }))?.status, 'DOWNLOADING');
    const history = await prisma.otaStatusHistory.findMany({ where: { targetId: target.id } });
    assert.equal(history.length, 1);
    // 不回改任何 Command
    assert.equal((await prisma.deviceCommand.findUnique({ where: { id: ctx.commandId } }))?.status, 'PUBLISHED');
    assert.equal(await prisma.commandAck.count({ where: { commandId: ctx.commandId } }), 0);

    // COMMAND ACK 混入 OTA 字段 → 隔离，命令不变
    const mixed = await h.handler({
      Records: [
        {
          messageId: 'sqs-mixed',
          body: envelopeBody(
            'ack',
            ackPayload('ACK-E2E-MIX', 12, {
              objectType: 'COMMAND',
              commandId: ctx.commandId,
              command: 'STOP',
              result: 'SUCCESS',
              otaTargetId: target.id,
            }),
            ctx,
          ),
        },
      ],
    });
    assert.deepEqual(mixed.batchItemFailures, []);
    assert.equal(h.quarantined.length, 1);
    assert.equal(h.quarantined[0]?.errorType, 'INVALID_ENVELOPE');
    assert.equal((await prisma.deviceCommand.findUnique({ where: { id: ctx.commandId } }))?.status, 'PUBLISHED');
  });

  test('路由表：heartbeat 经分发器落 device_latest_state；无注册 Handler 类型 → NO_HANDLER 隔离', async () => {
    const ctx = await plantDeviceWithCommand();
    const h = harness();
    const hb = await h.handler({
      Records: [
        {
          messageId: 'sqs-hb-1',
          body: envelopeBody(
            'heartbeat',
            {
              meta: { id: 'HB-ACKD-1', ts: TS, seq: 1 },
              data: {
                deviceStatus: 'ONLINE',
                uptimeSeconds: 60,
                firmwareVersion: '1.2.3',
                operationalStatus: 'ACTIVE',
                machineRunning: true,
                machineMode: 'IDLE',
                licenseStatus: 'ACTIVE',
                networkType: '4G',
                networkStatus: 'CONNECTED',
                sensorOverallStatus: 'NORMAL',
              },
            },
            ctx,
          ),
        },
      ],
    });
    assert.deepEqual(hb.batchItemFailures, []);
    assert.deepEqual(h.quarantined, []);
    const state = await prisma.deviceLatestState.findUnique({ where: { deviceId: ctx.deviceId } });
    assert.equal(state?.connectivity, 'ONLINE');

    // media 类型无注册 Handler（上行元数据由 BE-MED-01 设备端 API 处理）→ 确定异常路径
    const dispatcher = createBusinessDispatcher({ client: prisma, securePackage: securePackageStub });
    const mediaMessage = {
      envelope: {
        iotTopic: `bnx/device/${ctx.deviceId}/media`,
        iotDeviceId: ctx.deviceId,
        iotType: 'media',
        iotReceivedAt: RECEIVED_AT,
        iotPrincipal: 'arn:aws:iot:ap-southeast-1:123456789012:cert/x',
        payload: { meta: { id: 'MED-1', ts: TS, seq: 1 }, data: {} },
      },
      device: {
        deviceId: ctx.deviceId,
        customerId: ctx.customerId,
        lifecycleStatus: 'Active',
        certificateId: 'x',
        certificateFingerprint: 'f'.repeat(64),
      },
      messageId: 'MED-1',
      occurredAt: TS,
      data: {},
      audit: null,
    } as unknown as ValidatedMessage;
    try {
      await dispatcher(mediaMessage);
      assert.fail('media 应进入 NO_HANDLER 隔离');
    } catch (err) {
      assert.ok(err instanceof IngestError);
      assert.equal(err.errorType, 'NO_HANDLER');
      assert.equal(err.classification, 'QUARANTINE');
    }
  });
});
