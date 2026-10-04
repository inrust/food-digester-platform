/**
 * BE-DUSR-01 Device User 管理 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 跨 Customer 分配失败（409）；
 * - 停用用户不进入新 Sync（listDeviceUsersForSync 仅 ACTIVE）；
 * - 通知（USERS_CHANGED Outbox 每设备一条）和审计正确（device.user.* 各一次）；
 * - 受控接收明文密码并立即派生 PHC（DEC-004）；DTO 永不返回 PHC；CustomerAdmin 租户强制。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  ADMIN_DEVICE_USER_ERROR_HTTP_STATUS,
  USERS_CHANGED_NOTIFICATION,
  createAdminDeviceUserHandlers,
  listDeviceUsersForSync,
} from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-29T12:00:00Z');
const now = () => NOW;

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

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers() {
  return createAdminDeviceUserHandlers({ client: prisma, now });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

function writeReq(actor: ActorContext, version: number, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return req(actor, { ...options, headers: { 'If-Match': String(version) } });
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ListBody = { data: Record<string, unknown>[]; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

const DEVICE_PASSWORD = 'device-local-password';
const DEVICE_USER_PHC =
  '$argon2id$v=19$m=32768,t=3,p=1$AAECAwQFBgcICQoLDA0ODw$u+TOcl2LGub4w/cLIdrGdoG/cbU//EuAXDXm+qRHfqs';

let seq = 0;
async function plantCustomer() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer DU ${seq}` } });
  return customer.id;
}

async function plantDevice(customerId: string, options: { lifecycle?: string; siteId?: string } = {}) {
  seq += 1;
  const deviceId = `dev-du-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-DU-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycle ?? 'Active',
      customerId,
      ...(options.siteId ? { siteId: options.siteId } : {}),
    },
  });
  return deviceId;
}

describe('Region/Subregion/Device 权威拓扑筛选', () => {
  test('仅匹配具有目标设备 ACTIVE 分配的设备操作员', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const site = await prisma.site.create({
      data: { customerId, name: 'DU Site', region: 'Region-DU', subregion: 'Sub-DU', timezone: 'Asia/Shanghai' },
    });
    const matchingDevice = await plantDevice(customerId, { siteId: site.id });
    const otherDevice = await plantDevice(customerId);
    const matchingUser = await createUser(h, customerId, `matching-${seq}`);
    const otherUser = await createUser(h, customerId, `other-${seq}`);
    await h.assign(
      writeReq(superAdmin, 1, {
        params: { deviceUserId: matchingUser.deviceUserId as string },
        body: { deviceIds: [matchingDevice], reason: 'topology test' },
      }),
    );
    await h.assign(
      writeReq(superAdmin, 1, {
        params: { deviceUserId: otherUser.deviceUserId as string },
        body: { deviceIds: [otherDevice], reason: 'topology test' },
      }),
    );
    for (const query of [
      { region: 'Region-DU' },
      { subregion: 'Sub-DU' },
      { deviceId: matchingDevice },
      { region: 'Region-DU', subregion: 'Sub-DU', deviceId: matchingDevice },
    ]) {
      const response = await h.list(req(superAdmin, { query }));
      assert.equal(response.status, 200);
      assert.deepEqual(
        (response.body as ListBody).data.map((row) => row.deviceUserId),
        [matchingUser.deviceUserId],
      );
    }
    const conjunctiveMiss = await h.list(
      req(superAdmin, {
        query: { region: 'Other-Region', subregion: 'Sub-DU', deviceId: matchingDevice },
      }),
    );
    assert.equal(conjunctiveMiss.status, 200);
    assert.deepEqual((conjunctiveMiss.body as ListBody).data, []);
  });
});

async function createUser(h: ReturnType<typeof handlers>, customerId: string, username?: string) {
  const res = await h.create(
    req(superAdmin, {
      body: {
        customerId,
        username: username ?? `operator-${seq}-${Math.random().toString(36).slice(2, 6)}`,
        displayName: '操作员',
        password: DEVICE_PASSWORD,
        reason: '开通',
      },
    }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assertOpenApiResponse('createDeviceUser', 201, res.body);
  return (res.body as DataBody).data;
}

async function auditCount(objectId: string, action: string) {
  return prisma.auditLog.count({ where: { objectId, action, result: 'SUCCESS' } });
}

async function usersChangedCount(deviceId: string) {
  const events = await prisma.outboxEvent.findMany({ where: { eventType: USERS_CHANGED_NOTIFICATION } });
  return events.filter((e) => (e.payload as { deviceId?: string }).deviceId === deviceId).length;
}

describe('完整链路：创建→修改→分配→撤销→停用', () => {
  test('每步 version+1、审计各一次、USERS_CHANGED 每设备一条', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const d1 = await plantDevice(customerId);
    const d2 = await plantDevice(customerId);
    const u = await createUser(h, customerId);
    const userId = u.deviceUserId as string;
    assert.equal(u.version, 1);
    // DTO 不含验证材料
    assert.ok(!('passwordHash' in u) && !('password' in u), 'DTO 脱敏');

    // 分配两台设备（device-user:write = SuperAdmin/CustomerAdmin；Operator 无该权限）
    const assigned = await h.assign(
      writeReq(superAdmin, 1, { params: { deviceUserId: userId }, body: { deviceIds: [d1, d2], reason: '上岗' } }),
    );
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(await usersChangedCount(d1), 1);
    assert.equal(await usersChangedCount(d2), 1);
    let detail = ((await h.detail(req(auditor, { params: { deviceUserId: userId } }))).body as DataBody).data;
    assert.equal(detail.version, 2);
    assert.equal((detail.assignments as unknown[]).length, 2);
    const syncStates = detail.syncStates as {
      deviceId: string;
      entityVersion: number | null;
      notificationStatus: string;
      deliveredEntityVersion: number | null;
      snapshotStatus: string;
      deviceApplyStatus: string;
    }[];
    assert.equal(syncStates.find((state) => state.deviceId === d1)?.entityVersion, 2);
    assert.equal(syncStates.find((state) => state.deviceId === d1)?.notificationStatus, 'PENDING');
    assert.equal(syncStates.find((state) => state.deviceId === d1)?.snapshotStatus, 'NOT_SERVED');
    assert.equal(syncStates.find((state) => state.deviceId === d1)?.deviceApplyStatus, 'NOT_REPORTED');

    await (
      prisma as unknown as {
        deviceUserSyncReceipt: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
      }
    ).deviceUserSyncReceipt.create({
      data: {
        deviceId: d1,
        deviceUserId: userId,
        entityVersion: 2,
        servedAt: NOW,
        acknowledgedAt: NOW,
        deviceReportedLastSyncAt: NOW,
      },
    });
    detail = ((await h.detail(req(auditor, { params: { deviceUserId: userId } }))).body as DataBody).data;
    const acknowledged = (detail.syncStates as typeof syncStates).find((state) => state.deviceId === d1);
    assert.equal(acknowledged?.deliveredEntityVersion, 2);
    assert.equal(acknowledged?.snapshotStatus, 'ACKNOWLEDGED');

    // 密码轮换 → version+1 + 两设备各再一条通知
    const rotated = await h.update(
      writeReq(superAdmin, 2, {
        params: { deviceUserId: userId },
        body: { password: 'rotated-device-password', reason: '改密' },
      }),
    );
    assert.equal(rotated.status, 200);
    assert.equal((rotated.body as DataBody).data.version, 3);
    assert.equal(await usersChangedCount(d1), 2);

    // 撤销 d1
    const revoked = await h.revoke(
      writeReq(superAdmin, 3, { params: { deviceUserId: userId }, body: { deviceIds: [d1], reason: '调岗' } }),
    );
    assert.equal(revoked.status, 200);
    assert.equal(await usersChangedCount(d1), 3);
    detail = ((await h.detail(req(auditor, { params: { deviceUserId: userId } }))).body as DataBody).data;
    const history = detail.assignments as { deviceId: string; status: string; revokedAt: string | null }[];
    const d1Rows = history.filter((a) => a.deviceId === d1);
    assert.equal(d1Rows[0]?.status, 'REVOKED');
    assert.equal(d1Rows[0]?.revokedAt, NOW.toISOString());

    // 停用
    const disabled = await h.disable(
      writeReq(superAdmin, 4, { params: { deviceUserId: userId }, body: { reason: '离职' } }),
    );
    assert.equal(disabled.status, 200);
    assert.equal((disabled.body as DataBody).data.status, 'DISABLED');
    assert.equal((disabled.body as DataBody).data.version, 5);
    assert.equal(await usersChangedCount(d2), 3, '停用通知剩余 ACTIVE 分配设备');

    // 审计各恰好一次
    assert.equal(await auditCount(customerId, 'device.user.create'), 1);
    assert.equal(await auditCount(userId, 'device.user.assign'), 1);
    assert.equal(await auditCount(userId, 'device.user.update'), 1);
    assert.equal(await auditCount(userId, 'device.user.revoke'), 1);
    assert.equal(await auditCount(userId, 'device.user.disable'), 1);
  });

  test('停用用户不进入新 Sync；停用后不可更新/新分配', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const d1 = await plantDevice(customerId);
    const u = await createUser(h, customerId);
    const userId = u.deviceUserId as string;
    await h.assign(
      writeReq(superAdmin, 1, { params: { deviceUserId: userId }, body: { deviceIds: [d1], reason: 'x' } }),
    );

    // Sync 读取路径：ACTIVE 用户含 ACTIVE 分配
    let sync = await listDeviceUsersForSync({ client: prisma, now }, customerId);
    assert.ok(sync.some((s) => s.userId === userId && s.assignments.some((a) => a.deviceId === d1)));

    await h.disable(writeReq(superAdmin, 2, { params: { deviceUserId: userId }, body: { reason: '停用' } }));
    sync = await listDeviceUsersForSync({ client: prisma, now }, customerId);
    assert.ok(!sync.some((s) => s.userId === userId), '停用用户不进入新 Sync');

    // 停用后不可更新/新分配
    assert.equal(
      (
        await h.update(
          writeReq(superAdmin, 3, { params: { deviceUserId: userId }, body: { displayName: 'x', reason: 'x' } }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await h.assign(
          writeReq(superAdmin, 3, { params: { deviceUserId: userId }, body: { deviceIds: [d1], reason: 'x' } }),
        )
      ).status,
      409,
    );
    // 重复停用 → 409
    assert.equal(
      (await h.disable(writeReq(superAdmin, 3, { params: { deviceUserId: userId }, body: { reason: 'x' } }))).status,
      409,
    );
  });
});

describe('安全与冲突', () => {
  test('受控 password 可用；预计算 Hash/冻结前四组件被拒；空密码 400；用户名唯一 409', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const created = await h.create(
      req(superAdmin, {
        body: { customerId, username: 'op-x', password: DEVICE_PASSWORD },
      }),
    );
    assert.equal(created.status, 201);
    const precomputed = await h.create(
      req(superAdmin, {
        body: { customerId, username: 'op-precomputed', password: DEVICE_PASSWORD, passwordHash: DEVICE_USER_PHC },
      }),
    );
    assert.equal(precomputed.status, 400);
    assert.equal((precomputed.body as ErrorBody).error.code, 'VALIDATION_FAILED');
    assert.equal(
      (await h.create(req(superAdmin, { body: { customerId, username: 'op-y', password: '' } }))).status,
      400,
    );
    // 用户名唯一
    const u = await createUser(h, customerId, 'dup-name');
    const dup = await h.create(
      req(superAdmin, { body: { customerId, username: 'dup-name', password: DEVICE_PASSWORD } }),
    );
    assert.equal(dup.status, 409);
    // 冻结前四组件 → 400
    assert.equal(
      (
        await h.update(
          writeReq(superAdmin, 1, {
            params: { deviceUserId: u.deviceUserId as string },
            body: { verifierValue: 'legacy', reason: 'x' },
          }),
        )
      ).status,
      400,
    );
  });

  test('跨 Customer 分配失败且全成或全败；部分撤销无 ACTIVE → 409 回滚；If-Match 漂移 409', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const otherCustomer = await plantCustomer();
    const d1 = await plantDevice(customerId);
    const cross = await plantDevice(otherCustomer);
    const u = await createUser(h, customerId);
    const userId = u.deviceUserId as string;

    // 跨 Customer 分配 → 409 零写入零通知
    const crossAssign = await h.assign(
      writeReq(superAdmin, 1, { params: { deviceUserId: userId }, body: { deviceIds: [d1, cross], reason: 'x' } }),
    );
    assert.equal(crossAssign.status, 409);
    assert.equal(await prisma.deviceUserAssignment.count({ where: { deviceUserId: userId } }), 0, '全部回滚');
    assert.equal(await usersChangedCount(d1), 0);
    assert.equal(await auditCount(userId, 'device.user.assign'), 0);

    // 正常分配 d1
    await h.assign(
      writeReq(superAdmin, 1, { params: { deviceUserId: userId }, body: { deviceIds: [d1], reason: 'x' } }),
    );
    // 重复 ACTIVE 分配（部分唯一索引兜底）→ 409
    assert.equal(
      (
        await h.assign(
          writeReq(superAdmin, 2, { params: { deviceUserId: userId }, body: { deviceIds: [d1], reason: 'x' } }),
        )
      ).status,
      409,
    );
    // 部分撤销无 ACTIVE（d2 未分配）→ 409 且 d1 仍 ACTIVE
    const d2 = await plantDevice(customerId);
    const partial = await h.revoke(
      writeReq(superAdmin, 2, { params: { deviceUserId: userId }, body: { deviceIds: [d1, d2], reason: 'x' } }),
    );
    assert.equal(partial.status, 409);
    assert.equal(
      await prisma.deviceUserAssignment.count({ where: { deviceUserId: userId, deviceId: d1, status: 'ACTIVE' } }),
      1,
      '全成或全败：回滚',
    );
    // If-Match 漂移 → 409 VERSION_CONFLICT
    const stale = await h.disable(writeReq(superAdmin, 1, { params: { deviceUserId: userId }, body: { reason: 'x' } }));
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrorBody).error.code, 'VERSION_CONFLICT');
    // 缺 If-Match / 缺原因 → 400
    assert.equal(
      (await h.disable(req(superAdmin, { params: { deviceUserId: userId }, body: { reason: 'x' } }))).status,
      400,
    );
    assert.equal(
      (await h.disable(writeReq(superAdmin, 2, { params: { deviceUserId: userId }, body: {} }))).status,
      400,
    );
  });
});

describe('租户隔离与权限', () => {
  test('CustomerAdmin 只能管理自身 Customer；跨 Customer 404；未认证 401；Viewer 写 403', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const otherCustomer = await plantCustomer();
    const u = await createUser(h, customerId);
    const userId = u.deviceUserId as string;
    const customerAdmin: ActorContext = {
      ...superAdmin,
      actorId: 'ca-1',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId,
    };
    const otherAdmin: ActorContext = { ...customerAdmin, actorId: 'ca-2', customerId: otherCustomer };
    const viewer: ActorContext = { ...customerAdmin, actorId: 'cv-1', roles: ['CustomerViewer'] };

    // CustomerAdmin 创建强制本 Customer（入参他 Customer 被覆盖）
    const forced = await h.create(
      req(customerAdmin, {
        body: { customerId: otherCustomer, username: 'op-ca', password: DEVICE_PASSWORD },
      }),
    );
    assert.equal(forced.status, 201);
    assert.equal((forced.body as DataBody).data.customerId, customerId, '租户强制本 Customer');
    // 本 Customer 读写放行；跨 Customer 详情/停用 → 404
    assert.equal((await h.detail(req(customerAdmin, { params: { deviceUserId: userId } }))).status, 200);
    assert.equal((await h.detail(req(otherAdmin, { params: { deviceUserId: userId } }))).status, 404);
    assert.equal(
      (await h.disable(writeReq(otherAdmin, 1, { params: { deviceUserId: userId }, body: { reason: 'x' } }))).status,
      404,
    );
    // 列表租户隔离
    const otherList = await h.list(req(otherAdmin, {}));
    assert.ok(!(otherList.body as ListBody).data.some((r) => r.deviceUserId === userId));
    // CustomerViewer 只读：写 403
    assert.equal(
      (await h.disable(writeReq(viewer, 1, { params: { deviceUserId: userId }, body: { reason: 'x' } }))).status,
      403,
    );
    const ownList = await h.list(req(viewer, {}));
    assert.equal(ownList.status, 200);
    assert.ok((ownList.body as ListBody).data.some((row) => row.deviceUserId === userId));
    assert.ok((ownList.body as ListBody).data.every((row) => row.customerId === customerId));
    assert.equal((await h.detail(req(viewer, { params: { deviceUserId: userId } }))).status, 200);
    const foreignUser = await createUser(h, otherCustomer);
    assert.equal(
      (await h.detail(req(viewer, { params: { deviceUserId: foreignUser.deviceUserId as string } }))).status,
      404,
    );
    const foreignFilter = await h.list(req(viewer, { query: { customerId: otherCustomer } }));
    assert.equal(foreignFilter.status, 200);
    assert.ok((foreignFilter.body as ListBody).data.every((row) => row.customerId === customerId));
    // 隐藏按钮之外，直接调用全部写入口仍拒绝。
    assert.equal(
      (await h.create(req(viewer, { body: { customerId, username: 'viewer-write', password: DEVICE_PASSWORD } })))
        .status,
      403,
    );
    for (const mutate of [h.update, h.assign, h.revoke]) {
      assert.equal(
        (await mutate(writeReq(viewer, 1, { params: { deviceUserId: userId }, body: { reason: 'x' } }))).status,
        403,
      );
    }
    // Operator 无 device-user 权限（DEC-012）：读/写均 403
    assert.equal((await h.list(req(operator, {}))).status, 403);
    assert.equal(
      (await h.create(req(operator, { body: { customerId, username: 'op-z', password: DEVICE_PASSWORD } }))).status,
      403,
    );
    // Auditor 只读放行
    assert.equal((await h.list(req(auditor, {}))).status, 200);
    // 未认证 401
    assert.equal((await h.list(req(undefined, {}))).status, 401);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('错误码与 CT-05 目录一致；DTO 与 OpenAPI 契约一致且脱敏', async () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_DEVICE_USER_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
    const api = loadJson('admin-device-user-api.json');
    const h = handlers();
    const customerId = await plantCustomer();
    const u = await createUser(h, customerId);
    assert.deepEqual(Object.keys(u).sort(), [...api.components.schemas.DeviceUser.required].sort());
    // 脱敏：DB 行有 PHC，DTO 无
    const row = await prisma.deviceUser.findFirst({ where: { id: u.deviceUserId as string } });
    assert.match(row?.passwordHash ?? '', /^\$argon2id\$v=19\$m=32768,t=3,p=1\$/);
    assert.isNull(row?.verifierValue, '不再写冻结前 verifierValue');
    assert.ok(!JSON.stringify(u).includes(row?.passwordHash ?? '__missing__'), 'DTO 不含 PHC');
  });

  test('admin/device-user 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/device-user/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
