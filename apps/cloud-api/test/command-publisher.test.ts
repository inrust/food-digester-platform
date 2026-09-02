/**
 * BE-CMD-02 Command MQTT 发布器验收（PGlite 真实 PostgreSQL + 全部 migration；Fake MqttPublisher 注入端口）。
 *
 * 验收基准覆盖：
 * - 在线合法设备收到正确 Topic（bnx/device/{deviceId}/cmd）/ Payload（cmd.schema.json meta+data）/ QoS 1
 *   （ADP-002@1.0.0：specified 2 → AWS 有效 1）；
 * - 发布前重校验：Retired 设备 / 过期 expiresAt / 非可发布状态 → 不发布；
 * - 发布成功 → PUBLISHED + attempts 落行；发布异常 → FAILED 可重试（attemptNo 递增）；
 * - 发布重试不创建新 commandId（meta.id 幂等键不变）；PUBLISHED 幂等重放不重复发消息；
 * - 不等待设备同步响应、不推测执行成功（ACK/超时扫描属 BE-CMD-03）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  AdminCommandError,
  buildCommandPayload,
  commandTopicOf,
  publishCommand,
  COMMAND_PUBLISH_QOS,
} from '../src/index.js';
import type { CommandMqttPublishInput } from '../src/index.js';
import { createTestDb } from './helpers.js';

const cmdSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../contracts/mqtt/schemas/cmd.schema.json', import.meta.url)), 'utf8'),
) as { properties: { data: { required: string[] } } };

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-31T10:00:00Z');

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

class FakeMqtt {
  calls: CommandMqttPublishInput[] = [];
  failNext = false;
  async publish(input: CommandMqttPublishInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('broker unavailable');
    }
    this.calls.push(input);
  }
}

let seq = 0;

async function plantCommand(options: {
  status?: string;
  lifecycleStatus?: string;
  expiresAt?: Date | null;
  timeoutSec?: number;
  remarks?: string | null;
}): Promise<{ commandId: string; deviceId: string }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `PUB ${seq}` } });
  const deviceId = `dev-pub-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-PUB-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      customerId: customer.id,
    },
  });
  const commandId = `CMD-PUB-${seq}`;
  await prisma.deviceCommand.create({
    data: {
      id: commandId,
      deviceId,
      customerId: customer.id,
      command: 'STOP',
      category: 'MACHINE',
      status: options.status ?? 'AUTHORIZED',
      requestedBy: 'op-1',
      requestTime: NOW,
      timeoutSec: options.timeoutSec ?? 120,
      expiresAt: options.expiresAt === undefined ? new Date(NOW.getTime() + 120_000) : options.expiresAt,
      remarks: options.remarks ?? null,
    },
  });
  return { commandId, deviceId };
}

async function rejectsWith(fn: () => Promise<unknown>, code: string): Promise<AdminCommandError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AdminCommandError, `应为 AdminCommandError，实际 ${String(err)}`);
    assert.equal((err as AdminCommandError).code, code);
    return err as AdminCommandError;
  }
  assert.fail(`应抛出 ${code}`);
}

describe('Topic / Payload / QoS', () => {
  test('AUTHORIZED 命令发布成功：正确 Topic、QoS 1、Payload 符合 cmd.schema.json，状态 PUBLISHED + attempts 落行', async () => {
    const { commandId, deviceId } = await plantCommand({ remarks: '例行停止' });
    const mqtt = new FakeMqtt();
    const result = await publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId);

    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.attemptNo, 1);
    assert.equal(mqtt.calls.length, 1);
    const call = mqtt.calls[0]!;
    assert.equal(call.topic, `bnx/device/${deviceId}/cmd`);
    assert.equal(call.qos, COMMAND_PUBLISH_QOS);
    assert.equal(call.qos, 1, 'ADP-002@1.0.0：specified QoS 2 → AWS 有效 QoS 1');

    const envelope = JSON.parse(call.payload) as {
      meta: { id: string; ts: string };
      data: Record<string, unknown>;
    };
    assert.equal(envelope.meta.id, commandId, 'meta.id 即幂等键 commandId（DEC-006）');
    assert.equal(envelope.meta.ts, NOW.toISOString());
    assert.ok(!('seq' in envelope.meta), '下行 meta.seq 可选，V1 不发送');
    for (const key of cmdSchema.properties.data.required) {
      assert.ok(key in envelope.data, `data 缺必填字段 ${key}`);
    }
    assert.equal(envelope.data.command, 'STOP');
    assert.equal(envelope.data.requestedBy, 'op-1');
    assert.equal(envelope.data.requestTime, NOW.toISOString());
    assert.equal(envelope.data.timeoutSec, 120);
    assert.equal(envelope.data.remarks, '例行停止');
    assert.ok(!('audit' in envelope), 'Envelope 无 audit 域');

    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: commandId } });
    assert.equal(row.status, 'PUBLISHED');
    const attempts = await prisma.commandAttempt.findMany({ where: { commandId } });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.attemptNo, 1);
  });

  test('buildCommandPayload：remarks 为空省略；meta.id 匹配大写模式', async () => {
    const { commandId } = await plantCommand({});
    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: commandId } });
    const payload = JSON.parse(buildCommandPayload(row, NOW)) as {
      meta: { id: string };
      data: Record<string, unknown>;
    };
    assert.match(payload.meta.id, /^[A-Z0-9][A-Z0-9-]{0,127}$/);
    assert.ok(!('remarks' in payload.data), 'remarks null 不出现在 Payload');
  });
});

describe('发布前重校验', () => {
  test('Retired 设备 → DEVICE_STATE_NOT_ALLOWED，不发消息、不落 attempt', async () => {
    const { commandId } = await plantCommand({ lifecycleStatus: 'Retired' });
    const mqtt = new FakeMqtt();
    await rejectsWith(
      () => publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId),
      'DEVICE_STATE_NOT_ALLOWED',
    );
    assert.equal(mqtt.calls.length, 0);
    assert.equal(await prisma.commandAttempt.count({ where: { commandId } }), 0);
    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: commandId } });
    assert.equal(row.status, 'AUTHORIZED', '状态不被改动');
  });

  test('expiresAt 已过 → CONFLICT 拒绝再次发布，不发消息', async () => {
    const { commandId } = await plantCommand({ expiresAt: new Date(NOW.getTime() - 1000) });
    const mqtt = new FakeMqtt();
    await rejectsWith(() => publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId), 'CONFLICT');
    assert.equal(mqtt.calls.length, 0);
  });

  test('非可发布状态（ACKNOWLEDGED/TIMED_OUT/CANCELLED/CREATED）→ CONFLICT；命令不存在 → NOT_FOUND', async () => {
    const mqtt = new FakeMqtt();
    for (const status of ['ACKNOWLEDGED', 'TIMED_OUT', 'CANCELLED', 'CREATED']) {
      const { commandId } = await plantCommand({ status });
      await rejectsWith(() => publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId), 'CONFLICT');
    }
    assert.equal(mqtt.calls.length, 0);
    await rejectsWith(() => publishCommand({ client: prisma, now: () => NOW, mqtt }, 'CMD-MISSING'), 'NOT_FOUND');
  });
});

describe('幂等与重试', () => {
  test('PUBLISHED 幂等重放：REPLAYED_PUBLISHED，不重复发消息、不新增 attempt', async () => {
    const { commandId } = await plantCommand({});
    const mqtt = new FakeMqtt();
    await publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId);
    const replay = await publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId);
    assert.equal(replay.status, 'REPLAYED_PUBLISHED');
    assert.equal(mqtt.calls.length, 1, '重放不重复发消息');
    assert.equal(await prisma.commandAttempt.count({ where: { commandId } }), 1);
  });

  test('发布异常 → FAILED 可重试；重试不创建新 commandId，attemptNo 递增', async () => {
    const { commandId, deviceId } = await plantCommand({});
    const mqtt = new FakeMqtt();
    mqtt.failNext = true;
    const failed = await publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attemptNo, 1);
    let row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: commandId } });
    assert.equal(row.status, 'FAILED');

    const retried = await publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId);
    assert.equal(retried.status, 'PUBLISHED');
    assert.equal(retried.commandId, commandId, '重试不创建新 commandId');
    assert.equal(retried.attemptNo, 2, 'attemptNo 递增');
    assert.equal(mqtt.calls.length, 1);
    assert.equal(mqtt.calls[0]!.topic, commandTopicOf(deviceId));

    row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: commandId } });
    assert.equal(row.status, 'PUBLISHED');
    const attempts = await prisma.commandAttempt.findMany({ where: { commandId }, orderBy: { attemptNo: 'asc' } });
    assert.deepEqual(
      attempts.map((a) => a.attemptNo),
      [1, 2],
    );
    assert.equal(await prisma.deviceCommand.count({ where: { deviceId } }), 1, '无新命令行');
  });

  test('FAILED 且已过期 → 拒绝再次发布', async () => {
    const { commandId } = await plantCommand({ expiresAt: new Date(NOW.getTime() + 5_000) });
    const mqtt = new FakeMqtt();
    mqtt.failNext = true;
    await publishCommand({ client: prisma, now: () => NOW, mqtt }, commandId);
    const later = new Date(NOW.getTime() + 10_000);
    await rejectsWith(() => publishCommand({ client: prisma, now: () => later, mqtt }, commandId), 'CONFLICT');
    assert.equal(mqtt.calls.length, 0);
  });
});
