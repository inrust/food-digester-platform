/**
 * BE-DEV-06 设备可编辑元数据 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 合法 alias 修改成功并留审计（trim + 新 updatedAt + device.metadata.update before/after）；
 * - 越权失败：Customer 角色无 device:write（DEC-012 冻结矩阵，本/跨 Customer 均 403）；
 *   CustomerViewer → 403；无 actor → 401；
 * - 并发冲突失败：If-Match 缺失/非法 → 400；过期/并发漂移 → 409 VERSION_CONFLICT；
 * - 空 alias / 超长值 → 400；alias 同 Customer 冲突 → 409 CONFLICT（跨 Customer 同名放行）；
 * - 受保护字段修改失败（deviceId/serialNumber/customerId/siteId/生命周期/连接状态/固件/
 *   证书等 → 400）；不接受任意 JSON merge patch；
 * - 失败请求不产生部分更新（全部失败用例校验库中 alias 与其他字段不变）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminDeviceHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-05T14:00:00Z');

const operator: ActorContext = {
  actorId: 'sub-meta-op',
  username: 'operator',
  actorType: 'platform',
  roles: ['PlatformOperator'],
  customerId: null,
  tokenUse: 'access',
};

const custActor = (customerId: string, role: 'CustomerAdmin' | 'CustomerViewer' = 'CustomerAdmin'): ActorContext => ({
  actorId: `sub-meta-${role}-${customerId.slice(0, 8)}`,
  username: 'cust',
  actorType: 'customer',
  roles: [role],
  customerId,
  tokenUse: 'access',
});

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const handlers = () => createAdminDeviceHandlers({ client: prisma, now: () => NOW });

type DataBody = { data: { deviceId: string; alias: string | null; updatedAt: string }; meta: Record<string, any> };
type ErrBody = { error: { code: string; message: string } };

let customerAId: string;
let customerBId: string;
let seq = 0;

async function plantDevice(customerId: string | null, alias: string | null = null): Promise<string> {
  seq += 1;
  const id = `dev-meta-${seq}`;
  await prisma.device.create({
    data: {
      id,
      serialNumber: `SN-META-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId,
      alias,
    },
  });
  return id;
}

async function ifMatchOf(deviceId: string): Promise<string> {
  const row = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
  return row.updatedAt.toISOString();
}

const patch = (actor: ActorContext | undefined, deviceId: string, body: Record<string, unknown>, ifMatch?: string) =>
  handlers().updateMetadata({
    actor,
    headers: ifMatch === undefined ? {} : { 'if-match': ifMatch },
    params: { deviceId },
    body,
    requestId: `req-${Math.random()}`,
  } as AdminHttpRequest);

async function aliasOf(deviceId: string): Promise<string | null> {
  return (await prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).alias;
}

beforeAll(async () => {
  const cA = await prisma.customer.create({ data: { name: 'META A' } });
  const cB = await prisma.customer.create({ data: { name: 'META B' } });
  customerAId = cA.id;
  customerBId = cB.id;
});

describe('BE-DEV-06 合法修改与审计', () => {
  test('合法 alias 修改成功（trim）并留审计；返回新 updatedAt 供下次 If-Match', async () => {
    const deviceId = await plantDevice(customerAId, '旧别名');
    const res = await patch(operator, deviceId, { alias: '  食堂二号机  ' }, await ifMatchOf(deviceId));
    assert.equal(res.status, 200);
    const view = (res.body as DataBody).data;
    assert.equal(view.alias, '食堂二号机');
    assert.equal(await aliasOf(deviceId), '食堂二号机');
    assert.equal(view.updatedAt, NOW.toISOString());

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'device', objectId: deviceId, action: 'device.metadata.update' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, operator.actorId);
    assert.deepEqual(audits[0]?.beforeValue, { alias: '旧别名' });
    assert.deepEqual(audits[0]?.afterValue, { alias: '食堂二号机' });

    // 新 updatedAt 作为下次 If-Match 基准可继续修改；清除别名（null）
    const cleared = await patch(operator, deviceId, { alias: null }, view.updatedAt);
    assert.equal(cleared.status, 200);
    assert.equal(await aliasOf(deviceId), null);
  });

  test('同值 alias 放行（自身不判重）；跨 Customer 同名放行', async () => {
    const a1 = await plantDevice(customerAId, '一号机');
    const b1 = await plantDevice(customerBId, null);
    // 同值更新自身
    const same = await patch(operator, a1, { alias: '一号机' }, await ifMatchOf(a1));
    assert.equal(same.status, 200);
    // 跨 Customer 同名不冲突
    const cross = await patch(operator, b1, { alias: '一号机' }, await ifMatchOf(b1));
    assert.equal(cross.status, 200);
  });
});

describe('BE-DEV-06 非法值与受保护字段（失败不产生部分更新）', () => {
  test('空 alias / 超长 / 非字符串 / 缺字段 → 400', async () => {
    const deviceId = await plantDevice(customerAId, '原别名');
    const cases: Record<string, unknown>[] = [
      { alias: '   ' }, // 空（trim 后）
      { alias: 'x'.repeat(65) }, // 超长
      { alias: 42 }, // 非字符串
      {}, // 缺 alias
    ];
    for (const body of cases) {
      const res = await patch(operator, deviceId, body, await ifMatchOf(deviceId));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    assert.equal(await aliasOf(deviceId), '原别名');
  });

  test('受保护字段（serialNumber/customerId/siteId/生命周期/连接/固件/证书等）→ 400 且无任何更新', async () => {
    const deviceId = await plantDevice(customerAId, '受保护');
    const before = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    const protectedFields = [
      'deviceId',
      'serialNumber',
      'customerId',
      'siteId',
      'contract',
      'license',
      'lifecycleStatus',
      'connectivity',
      'firmwareVersion',
      'certificate',
      '$set', // 任意 merge patch 操作符
    ];
    for (const field of protectedFields) {
      const res = await patch(operator, deviceId, { alias: '新别名', [field]: 'hack' }, await ifMatchOf(deviceId));
      assert.equal(res.status, 400, field);
    }
    const after = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    assert.deepEqual(after, before, '失败请求不得产生部分更新');
  });
});

describe('BE-DEV-06 If-Match 并发与唯一性冲突', () => {
  test('If-Match 缺失/非法 → 400；过期 → 409 VERSION_CONFLICT；并发漂移 → 409', async () => {
    const deviceId = await plantDevice(customerAId, null);
    // 缺失
    assert.equal((await patch(operator, deviceId, { alias: 'a' })).status, 400);
    // 非法
    assert.equal((await patch(operator, deviceId, { alias: 'a' }, 'not-a-date')).status, 400);
    // 过期（陈旧 updatedAt）
    const stale = await patch(operator, deviceId, { alias: 'a' }, '2026-09-05T13:00:00.000Z');
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrBody).error.code, 'VERSION_CONFLICT');
    // 并发漂移：拿到基准后他方先行修改
    const base = await ifMatchOf(deviceId);
    await prisma.device.update({
      where: { id: deviceId },
      data: { alias: '他方修改', updatedAt: new Date(NOW.getTime() + 1000) },
    });
    const drift = await patch(operator, deviceId, { alias: 'a' }, base);
    assert.equal(drift.status, 409);
    assert.equal(await aliasOf(deviceId), '他方修改');
  });

  test('alias 同一 Customer 内唯一：冲突 → 409 CONFLICT 且不落库', async () => {
    const a1 = await plantDevice(customerAId, '独占地名');
    const a2 = await plantDevice(customerAId, null);
    const res = await patch(operator, a2, { alias: ' 独占地名 ' }, await ifMatchOf(a2)); // trim 后冲突
    assert.equal(res.status, 409);
    assert.equal((res.body as ErrBody).error.code, 'CONFLICT');
    assert.equal(await aliasOf(a2), null);
    // 大小写敏感（暂定规则）：不同大小写放行
    const a3 = await plantDevice(customerAId, null);
    assert.equal((await patch(operator, a3, { alias: 'UNIQUE-Name' }, await ifMatchOf(a3))).status, 200);
    const a4 = await plantDevice(customerAId, null);
    assert.equal((await patch(operator, a4, { alias: 'unique-name' }, await ifMatchOf(a4))).status, 200);
    void a1;
  });
});

describe('BE-DEV-06 越权', () => {
  test('CustomerViewer 无 device:write → 403；Customer 角色跨 Customer → 403；无 actor → 401；不存在 → 404', async () => {
    const a1 = await plantDevice(customerAId, null);
    const b1 = await plantDevice(customerBId, null);
    // Viewer 无写权限
    assert.equal(
      (await patch(custActor(customerAId, 'CustomerViewer'), a1, { alias: 'x' }, await ifMatchOf(a1))).status,
      403,
    );
    // CustomerAdmin 亦无 device:write（DEC-012 冻结矩阵：设备元数据写仅平台角色）
    assert.equal((await patch(custActor(customerAId), a1, { alias: '本客户改名' }, await ifMatchOf(a1))).status, 403);
    assert.equal((await patch(custActor(customerAId), b1, { alias: 'x' }, await ifMatchOf(b1))).status, 403);
    assert.equal(await aliasOf(a1), null);
    assert.equal(await aliasOf(b1), null);
    // 未分配设备对 Customer 角色 → 403
    const unassigned = await plantDevice(null, null);
    assert.equal(
      (await patch(custActor(customerAId), unassigned, { alias: 'x' }, await ifMatchOf(unassigned))).status,
      403,
    );
    // 无 actor / 不存在
    assert.equal((await patch(undefined, a1, { alias: 'x' }, await ifMatchOf(a1))).status, 401);
    assert.equal((await patch(operator, 'ghost-device', { alias: 'x' }, NOW.toISOString())).status, 404);
  });
});
