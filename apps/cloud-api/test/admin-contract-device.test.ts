/**
 * BE-CON-02 Contract 与 Device 关联 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 未关联合约设备列表准确（同 Customer、非 Retired、无 ACTIVE 关联）；
 * - 批量操作全成或全败（单事务回滚验证）；
 * - 跨 Customer、重复关联和重叠租期失败（服务预检 + DB 排他约束兜底）；
 * - 解绑不误撤销 License（DEC-007），不改变 Device lifecycle；所有变化可审计；
 * - Contract 详情设备视图：Region/Subregion/Site、ID、别名、四轴状态、固件、租期展示值。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminContractDeviceHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-29T12:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;
const CONTRACT_START = new Date('2026-01-01T00:00:00Z');
const CONTRACT_END = new Date('2027-01-01T00:00:00Z');

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};
const operator: ActorContext = { ...superAdmin, actorId: 'op-1', roles: ['PlatformOperator'] };
const auditor: ActorContext = { ...superAdmin, actorId: 'au-1', roles: ['Auditor'] };
const customerAdmin: ActorContext = {
  ...superAdmin,
  actorId: 'ca-1',
  actorType: 'customer',
  roles: ['CustomerAdmin'],
  customerId: 'cust-x',
};

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers() {
  return createAdminContractDeviceHandlers({ client: prisma, now });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

type DataBody = { data: unknown; meta: Record<string, unknown> };

let seq = 0;
async function plantContract(options: { status?: string; startAt?: Date; endAt?: Date } = {}) {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer CD ${seq}` } });
  const site = await prisma.site.create({
    data: { customerId: customer.id, name: `Site CD ${seq}`, region: `Region-${seq}`, subregion: `Sub-${seq}` },
  });
  const contract = await prisma.contract.create({
    data: {
      contractNumber: `CT-CD-${seq}`,
      name: `合同 ${seq}`,
      customerId: customer.id,
      status: options.status ?? 'EFFECTIVE',
      startAt: options.startAt ?? CONTRACT_START,
      endAt: options.endAt ?? CONTRACT_END,
      createdBy: 'admin-1',
    },
  });
  return { contractId: contract.id, customerId: customer.id, siteId: site.id };
}

async function plantDevice(
  ctx: { customerId: string; siteId: string },
  options: { lifecycle?: string; alias?: string; withLicense?: boolean; heartbeatAt?: Date | null } = {},
) {
  seq += 1;
  const deviceId = `dev-cd-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-CD-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycle ?? 'Active',
      customerId: ctx.customerId,
      siteId: ctx.siteId,
      firmwareVersion: 'FW1.2',
      ...(options.alias !== undefined ? { alias: options.alias } : {}),
    },
  });
  if (options.heartbeatAt !== undefined) {
    await prisma.deviceLatestState.create({
      data: { deviceId, lastHeartbeatAt: options.heartbeatAt, operationalStatus: 'RUNNING' },
    });
  }
  if (options.withLicense) {
    await prisma.license.create({
      data: {
        deviceId,
        customerId: ctx.customerId,
        status: 'Active',
        validFrom: CONTRACT_START,
        validTo: CONTRACT_END,
        createdBy: 'admin-1',
      },
    });
  }
  return deviceId;
}

async function bind(
  h: ReturnType<typeof handlers>,
  contractId: string,
  deviceIds: string[],
  extra: Record<string, unknown> = {},
) {
  return h.bind(req(superAdmin, { params: { contractId }, body: { deviceIds, reason: '关联', ...extra } }));
}

describe('批量关联与全成或全败', () => {
  test('批量关联全成：ACTIVE 关联 + 审计一次；Contract 设备视图含四轴/固件/Region/别名/租期', async () => {
    const h = handlers();
    const ctx = await plantContract();
    const d1 = await plantDevice(ctx, { alias: '一号机', withLicense: true, heartbeatAt: NOW });
    const d2 = await plantDevice(ctx);

    const res = await bind(h, ctx.contractId, [d1, d2]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const data = (res.body as DataBody).data as { bound: string[]; associations: { status: string }[] };
    assert.deepEqual([...data.bound].sort(), [d1, d2].sort());
    assert.equal(data.associations.length, 2);
    // 缺省窗口 = 合同窗口
    const row = await prisma.contractDevice.findFirst({ where: { contractId: ctx.contractId, deviceId: d1 } });
    assert.equal(row?.status, 'ACTIVE');
    assert.equal(row?.validFrom.toISOString(), CONTRACT_START.toISOString());
    assert.equal(row?.validTo?.toISOString(), CONTRACT_END.toISOString());
    // 审计恰好一次（批量一条）
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: ctx.contractId, action: 'contract.devices.bind', result: 'SUCCESS' },
      }),
      1,
    );

    // 设备视图：Region/Subregion/Site、ID、别名、四轴状态、固件、租期展示值
    const devices = await h.listDevices(req(auditor, { params: { contractId: ctx.contractId } }));
    assert.equal(devices.status, 200);
    const items = (devices.body as DataBody).data as {
      association: { deviceId: string; validFrom: string; validTo: string | null; status: string };
      device: Record<string, unknown>;
    }[];
    assert.equal(items.length, 2);
    const v1 = items.find((i) => i.association.deviceId === d1);
    assert.ok(v1);
    assert.equal(v1.device.alias, '一号机');
    assert.equal(v1.device.firmwareVersion, 'FW1.2');
    const site = v1.device.site as { name: string; region: string | null; subregion: string | null } | null;
    assert.ok(site?.name.startsWith('Site CD'), 'Site 名称');
    assert.ok(site?.region?.startsWith('Region-'), 'Region');
    assert.ok(site?.subregion?.startsWith('Sub-'), 'Subregion');
    assert.equal(v1.device.lifecycleStatus, 'Active');
    assert.equal(v1.device.operationalStatus, 'RUNNING');
    assert.equal(v1.device.connectivity, 'ONLINE');
    assert.equal(v1.device.licenseStatus, 'Active');
    assert.equal(v1.association.status, 'ACTIVE');
    assert.equal(v1.association.validTo, CONTRACT_END.toISOString());
    const v2 = items.find((i) => i.association.deviceId === d2);
    assert.equal(v2?.device.connectivity, 'OFFLINE', '无心跳 → OFFLINE');
    assert.equal(v2?.device.licenseStatus, null);
  });

  test('批量全成或全败：任一设备非法（不存在/跨 Customer/Retired）→ 全部回滚', async () => {
    const h = handlers();
    const ctx = await plantContract();
    const good = await plantDevice(ctx);
    const other = await plantContract();
    const crossCustomer = await plantDevice(other);
    const retired = await plantDevice(ctx, { lifecycle: 'Retired' });

    for (const [name, deviceIds, status] of [
      ['不存在设备', [good, 'dev-missing'], 404],
      ['跨 Customer', [good, crossCustomer], 409],
      ['Retired 设备', [good, retired], 409],
    ] as const) {
      const res = await bind(h, ctx.contractId, [...deviceIds]);
      assert.equal(res.status, status, `${name} 必须 ${status}`);
      assert.equal(
        await prisma.contractDevice.count({ where: { contractId: ctx.contractId } }),
        0,
        `${name}：全部回滚`,
      );
    }
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: ctx.contractId, action: 'contract.devices.bind', result: 'SUCCESS' },
      }),
      0,
    );
  });

  test('跨 Customer、重复关联和重叠租期失败；相邻窗口可关联；EXPIRED/TERMINATED 合同 409', async () => {
    const h = handlers();
    const ctx = await plantContract();
    const d1 = await plantDevice(ctx);
    assert.equal((await bind(h, ctx.contractId, [d1])).status, 201);

    // 重复关联（同合同同设备）→ 409
    assert.equal((await bind(h, ctx.contractId, [d1])).status, 409);

    // 另一合同重叠租期 → 409（同 customer 新合同）
    const contract2 = await prisma.contract.create({
      data: {
        contractNumber: `CT-CD2-${seq}`,
        name: '二合同',
        customerId: ctx.customerId,
        status: 'EFFECTIVE',
        startAt: CONTRACT_START,
        endAt: CONTRACT_END,
        createdBy: 'admin-1',
      },
    });
    const overlap = await bind(h, contract2.id, [d1]);
    assert.equal(overlap.status, 409, '重叠租期必须 409');

    // 先解绑 d1，再验证相邻窗口：合同 A [S,E)，解绑后合同 B 同窗口可关联
    assert.equal(
      (
        await h.unbind(
          req(superAdmin, { params: { contractId: ctx.contractId }, body: { deviceIds: [d1], reason: '换约' } }),
        )
      ).status,
      200,
    );
    assert.equal((await bind(h, contract2.id, [d1])).status, 201, '解绑后相邻/同窗口可关联');

    // 窗口超出合同窗口 → 400
    const d2 = await plantDevice(ctx);
    const outOfWindow = await bind(h, contract2.id, [d2], {
      validFrom: CONTRACT_START.toISOString(),
      validTo: new Date(CONTRACT_END.getTime() + DAY_MS).toISOString(),
    });
    assert.equal(outOfWindow.status, 400);

    // EXPIRED/TERMINATED 合同不可关联 → 409
    const expired = await plantContract({ status: 'EXPIRED' });
    const dx = await plantDevice(expired);
    assert.equal((await bind(h, expired.contractId, [dx])).status, 409);
    const terminated = await plantContract({ status: 'TERMINATED' });
    const dy = await plantDevice(terminated);
    assert.equal((await bind(h, terminated.contractId, [dy])).status, 409);
  });
});

describe('解绑与历史', () => {
  test('批量解绑全成或全败；不误撤销 License、不改 lifecycle；关联历史可审计', async () => {
    const h = handlers();
    const ctx = await plantContract();
    const d1 = await plantDevice(ctx, { withLicense: true });
    const d2 = await plantDevice(ctx);
    assert.equal((await bind(h, ctx.contractId, [d1, d2])).status, 201);

    // 部分无关联 → 409 且全部回滚（d1 仍 ACTIVE）
    const partial = await h.unbind(
      req(superAdmin, {
        params: { contractId: ctx.contractId },
        body: { deviceIds: [d1, 'dev-never-bound'], reason: 'x' },
      }),
    );
    assert.equal(partial.status, 409);
    assert.equal(
      await prisma.contractDevice.count({ where: { contractId: ctx.contractId, status: 'ACTIVE' } }),
      2,
      '全成或全败：回滚',
    );

    // 正常解绑
    const res = await h.unbind(
      req(superAdmin, { params: { contractId: ctx.contractId }, body: { deviceIds: [d1, d2], reason: '合同变更' } }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual([...((res.body as DataBody).data as { unbound: string[] }).unbound].sort(), [d1, d2].sort());
    const rows = await prisma.contractDevice.findMany({ where: { contractId: ctx.contractId } });
    for (const row of rows) {
      assert.equal(row.status, 'ENDED');
      assert.ok(row.endedAt);
      assert.equal(row.validTo?.toISOString(), NOW.toISOString(), '窗口闭合于解绑时点');
    }
    // 不误撤销 License、不改 lifecycle（DEC-007）
    const license = await prisma.license.findFirst({ where: { deviceId: d1 } });
    assert.equal(license?.status, 'Active', '解绑不得撤销 License');
    const device = await prisma.device.findFirst({ where: { id: d1 } });
    assert.equal(device?.lifecycleStatus, 'Active', '关联事务不得改变 Device lifecycle');
    // 审计：bind 一次 + unbind 一次
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: ctx.contractId, action: 'contract.devices.unbind', result: 'SUCCESS' },
      }),
      1,
    );

    // 关联历史：全部 ACTIVE/ENDED 行
    const history = await h.listAssociations(req(auditor, { params: { contractId: ctx.contractId } }));
    assert.equal(history.status, 200);
    const items = (history.body as DataBody).data as { status: string; endedAt: string | null }[];
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.status === 'ENDED' && i.endedAt !== null));

    // 解绑后设备回到可关联列表
    const available = await h.listAvailable(req(operator, { params: { contractId: ctx.contractId } }));
    const availIds = ((available.body as DataBody).data as { deviceId: string }[]).map((d) => d.deviceId);
    assert.ok(availIds.includes(d1) && availIds.includes(d2));
  });
});

describe('可关联设备与权限', () => {
  test('未关联合约设备列表准确：同 Customer、非 Retired、无 ACTIVE 关联', async () => {
    const h = handlers();
    const ctx = await plantContract();
    const free = await plantDevice(ctx);
    const bound = await plantDevice(ctx);
    const retired = await plantDevice(ctx, { lifecycle: 'Retired' });
    await bind(h, ctx.contractId, [bound]);
    const other = await plantContract();
    const otherCustomerDevice = await plantDevice(other);

    const res = await h.listAvailable(req(operator, { params: { contractId: ctx.contractId } }));
    assert.equal(res.status, 200);
    const ids = ((res.body as DataBody).data as { deviceId: string }[]).map((d) => d.deviceId);
    assert.ok(ids.includes(free));
    assert.ok(!ids.includes(bound), '已 ACTIVE 关联不出现');
    assert.ok(!ids.includes(retired), 'Retired 不出现');
    assert.ok(!ids.includes(otherCustomerDevice), '跨 Customer 不出现');
  });

  test('权限：contract:write 仅 SuperAdmin；读含 Operator/Auditor；Customer 403；未认证 401；缺原因/空数组 400', async () => {
    const h = handlers();
    const ctx = await plantContract();
    const d1 = await plantDevice(ctx);

    // Operator/Auditor 读放行
    assert.equal((await h.listDevices(req(operator, { params: { contractId: ctx.contractId } }))).status, 200);
    assert.equal((await h.listAssociations(req(auditor, { params: { contractId: ctx.contractId } }))).status, 200);
    // Operator/Auditor 写 403；Customer 403；未认证 401
    assert.equal((await bind(h, ctx.contractId, [d1])).status, 201, '基线：SuperAdmin 可写');
    assert.equal(
      (await h.bind(req(operator, { params: { contractId: ctx.contractId }, body: { deviceIds: [d1], reason: 'x' } })))
        .status,
      403,
    );
    assert.equal(
      (await h.unbind(req(auditor, { params: { contractId: ctx.contractId }, body: { deviceIds: [d1], reason: 'x' } })))
        .status,
      403,
    );
    assert.equal((await h.listDevices(req(customerAdmin, { params: { contractId: ctx.contractId } }))).status, 403);
    assert.equal((await h.listDevices(req(undefined, { params: { contractId: ctx.contractId } }))).status, 401);
    // 缺原因 → 400；空 deviceIds → 400；合同不存在 → 404
    assert.equal(
      (await h.unbind(req(superAdmin, { params: { contractId: ctx.contractId }, body: { deviceIds: [d1] } }))).status,
      400,
    );
    assert.equal(
      (await h.bind(req(superAdmin, { params: { contractId: ctx.contractId }, body: { deviceIds: [], reason: 'x' } })))
        .status,
      400,
    );
    assert.equal((await h.listDevices(req(operator, { params: { contractId: 'ct-missing' } }))).status, 404);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('DTO 字段与 OpenAPI 契约一致', async () => {
    const api = loadJson('admin-contract-device-api.json');
    const h = handlers();
    const ctx = await plantContract();
    const d1 = await plantDevice(ctx);
    const bound = await bind(h, ctx.contractId, [d1]);
    const data = (bound.body as DataBody).data as { associations: Record<string, unknown>[] };
    assert.deepEqual(
      Object.keys(data.associations[0] ?? {}).sort(),
      [...api.components.schemas.ContractDeviceAssociation.required].sort(),
      'Association DTO 与契约一致',
    );
    const devices = await h.listDevices(req(auditor, { params: { contractId: ctx.contractId } }));
    const item = ((devices.body as DataBody).data as { device: Record<string, unknown> }[])[0];
    assert.deepEqual(
      Object.keys(item?.device ?? {}).sort(),
      [...api.components.schemas.ContractDeviceSnapshot.required].sort(),
      'ContractDeviceSnapshot DTO 与契约一致',
    );
    const available = await h.listAvailable(req(operator, { params: { contractId: ctx.contractId } }));
    const avail = ((available.body as DataBody).data as Record<string, unknown>[])[0];
    if (avail) {
      assert.deepEqual(
        Object.keys(avail).sort(),
        [...api.components.schemas.AvailableDevice.required].sort(),
        'AvailableDevice DTO 与契约一致',
      );
    }
  });

  test('admin/contract-device 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/contract-device/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
