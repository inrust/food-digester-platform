/**
 * BE-LIC-01 License/Entitlement API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 所有状态路径：Draft→Issued→Active→ExpiringSoon→Renewed→Active→Expired→Revoked 全链路；
 * - 非法路径：非法迁移 409、缺原因/非法参数 400、未分配/已退役设备 409、越权 403/401；
 * - 一个设备不能出现两个有效 License（创建阻断 + DB 部分唯一索引兜底）；
 * - 通知和审计各一次（每次真实变化恰好一条历史 + 一次审计 + 一个 LICENSE_CHANGED）；
 * - renew 幂等回放（同目标 → replayed，无写入；异目标 → 409）；
 * - evaluateAt 可测试（注入 at；无变化时无写入）；
 * - signature 供 Sync（Issue 生成、Renew 重签、确定性可验证）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  ADMIN_LICENSE_ERROR_HTTP_STATUS,
  createAdminLicenseHandlers,
  signLicensePayload,
  verifyLicensePayloadSignature,
} from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-28T19:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;
const SIGNING_KEY = 'test-license-signing-key';

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
  return createAdminLicenseHandlers({ client: prisma, signingKey: SIGNING_KEY, now });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

let seq = 0;
/** 落库已分配设备（Active 生命周期）。 */
async function plantAssignedDevice(options: { assigned?: boolean; lifecycle?: string } = {}) {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer LIC ${seq}` } });
  const site = await prisma.site.create({ data: { customerId: customer.id, name: `Site LIC ${seq}` } });
  const assigned = options.assigned ?? true;
  const deviceId = `dev-lic-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-LIC-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycle ?? 'Active',
      customerId: assigned ? customer.id : null,
      siteId: assigned ? site.id : null,
    },
  });
  return { deviceId, customerId: customer.id };
}

const VALID_FROM = new Date('2026-01-01T00:00:00Z');

async function createDraft(h: ReturnType<typeof handlers>, deviceId: string, validTo: Date) {
  const res = await h.create(
    req(operator, {
      body: {
        deviceId,
        validFrom: VALID_FROM.toISOString(),
        validTo: validTo.toISOString(),
        entitlements: ['REMOTE_CONTROL', 'OTA'],
        reason: '初始签发',
      },
    }),
  );
  assert.equal(res.status, 201);
  return (res.body as { data: Record<string, unknown> }).data;
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

function licenseSideEffects(licenseId: string) {
  return Promise.all([
    prisma.licenseHistory.count({ where: { licenseId } }),
    prisma.auditLog.count({ where: { objectId: licenseId, action: { startsWith: 'license.' } } }),
    prisma.outboxEvent.count({ where: { aggregateId: licenseId, eventType: 'LICENSE_CHANGED' } }),
    prisma.outboxEvent.count({ where: { aggregateId: licenseId, eventType: 'ARCHIVE' } }),
  ]);
}

describe('全状态路径：Draft→Issued→Active→ExpiringSoon→Renewed→Active→Expired→Revoked', () => {
  test('完整链路：每步状态/签名/历史/审计/通知各一次', async () => {
    const { deviceId, customerId } = await plantAssignedDevice();
    const h = handlers();

    // create Draft（201，signature=null，effective=true：Issued 前 Draft 不在有效集合 → false）
    const draft = await createDraft(h, deviceId, new Date(NOW.getTime() + 10 * DAY_MS));
    assert.equal(draft.status, 'Draft');
    assert.equal(draft.signature, null);
    assert.equal(draft.effective, false, 'Draft 不在有效集合');
    assert.equal(draft.customerId, customerId);
    assert.equal((draft.entitlements as { code: string }[]).length, 2);
    const licenseId = draft.licenseId as string;

    // issue → Issued + 签名（确定性可验证）
    const issued = await h.issue(req(operator, { params: { licenseId } }));
    assert.equal(issued.status, 200);
    const issuedData = (issued.body as DataBody).data;
    assert.equal(issuedData.status, 'Issued');
    const expectedSig = signLicensePayload(SIGNING_KEY, {
      licenseId,
      deviceId,
      customerId,
      validFrom: VALID_FROM,
      validTo: new Date(NOW.getTime() + 10 * DAY_MS),
      entitlements: ['REMOTE_CONTROL', 'OTA'],
    });
    assert.equal(issuedData.signature, expectedSig, 'Issue 生成签名供 Sync');
    assert.equal(issuedData.effective, true, 'Issued 在有效期内即有效');

    // activate → Active（已到 validFrom）
    const activated = await h.activate(req(operator, { params: { licenseId } }));
    assert.equal(activated.status, 200);
    assert.equal((activated.body as DataBody).data.status, 'Active');

    // evaluate（注入 at=NOW，validTo 在 30 天窗口内）→ ExpiringSoon
    const evalSoon = await h.evaluate(req(operator, { params: { licenseId }, body: { at: NOW.toISOString() } }));
    assert.equal(evalSoon.status, 200);
    assert.equal((evalSoon.body as DataBody).data.status, 'ExpiringSoon');
    assert.equal((evalSoon.body as DataBody).data.changed, true);

    // renew → Renewed + 延长 validTo + 重签
    const newValidTo = new Date(NOW.getTime() + 400 * DAY_MS);
    const renewed = await h.renew(
      req(operator, { params: { licenseId }, body: { newValidTo: newValidTo.toISOString() } }),
    );
    assert.equal(renewed.status, 200);
    const renewedData = (renewed.body as DataBody).data;
    assert.equal(renewedData.status, 'Renewed');
    assert.equal(renewedData.validTo, newValidTo.toISOString().slice(0, 10));
    assert.equal(renewedData.replayed, false);
    assert.notEqual(renewedData.signature, expectedSig, 'Renew 重签');
    const expectedRenewSig = signLicensePayload(SIGNING_KEY, {
      licenseId,
      deviceId,
      customerId,
      validFrom: VALID_FROM,
      validTo: newValidTo,
      entitlements: ['REMOTE_CONTROL', 'OTA'],
    });
    assert.equal(renewedData.signature, expectedRenewSig);

    // evaluate → Renewed 结算为 Active
    const settled = await h.evaluate(req(operator, { params: { licenseId }, body: { at: NOW.toISOString() } }));
    assert.equal((settled.body as DataBody).data.status, 'Active');

    // evaluate（at 超过 validTo）→ Expired
    const expiredAt = new Date(newValidTo.getTime() + DAY_MS);
    const expired = await h.evaluate(req(operator, { params: { licenseId }, body: { at: expiredAt.toISOString() } }));
    assert.equal((expired.body as DataBody).data.status, 'Expired');
    assert.equal((expired.body as DataBody).data.effective, false);

    // revoke（强制原因）→ Revoked
    const revoked = await h.revoke(req(operator, { params: { licenseId }, body: { reason: '客户违约' } }));
    assert.equal(revoked.status, 200);
    assert.equal((revoked.body as DataBody).data.status, 'Revoked');

    // 通知和审计各一次：create + 7 次迁移 = 8
    const [historyCount, auditCount, outboxCount, archiveCount] = await licenseSideEffects(licenseId);
    assert.equal(historyCount, 8, '每次变化恰好一条历史');
    assert.equal(auditCount, 8, '每次变化恰好一次审计');
    assert.equal(outboxCount, 8, '每次变化恰好一个 LICENSE_CHANGED');
    assert.equal(archiveCount, 8, '每次变化恰好一个 DEC-016 License 领域归档事件');
    const archive = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: licenseId, eventType: 'ARCHIVE' },
      orderBy: { createdAt: 'asc' },
    });
    const archivePayload = archive.payload as Record<string, unknown>;
    assert.equal(archivePayload.archiveClass, 'DOMAIN_EVENT');
    assert.equal(archivePayload.entityType, 'license');
    assert.notEqual(archivePayload.archiveClass, 'MQTT_RAW');

    // 历史倒序且链路完整
    const history = await h.history(req(auditor, { params: { licenseId } }));
    assert.equal(history.status, 200, 'Auditor 可读历史');
    const items = (history.body as { data: { fromStatus: string | null; toStatus: string }[] }).data;
    assert.deepEqual(items.map((i) => i.toStatus).reverse(), [
      'Draft',
      'Issued',
      'Active',
      'ExpiringSoon',
      'Renewed',
      'Active',
      'Expired',
      'Revoked',
    ]);
    assert.equal(items[0]?.toStatus, 'Revoked');

    // 详情（含签名与派生 effective）
    const detail = await h.detail(req(auditor, { params: { licenseId } }));
    assert.equal((detail.body as DataBody).data.signature, expectedRenewSig);
    assert.equal((detail.body as DataBody).data.status, 'Revoked');
  });

  test('renew 幂等：同目标回放无写入；异目标 409；版本递增', async () => {
    const { deviceId } = await plantAssignedDevice();
    const h = handlers();
    const draft = await createDraft(h, deviceId, new Date(NOW.getTime() + 10 * DAY_MS));
    const licenseId = draft.licenseId as string;
    await h.issue(req(operator, { params: { licenseId } }));
    await h.activate(req(operator, { params: { licenseId } }));
    await h.evaluate(req(operator, { params: { licenseId }, body: { at: NOW.toISOString() } }));

    const newValidTo = new Date(NOW.getTime() + 400 * DAY_MS);
    const first = await h.renew(
      req(operator, { params: { licenseId }, body: { newValidTo: newValidTo.toISOString() } }),
    );
    assert.equal((first.body as DataBody).data.version, 5, 'create/issue/activate/evaluate/renew 各递增一次');
    const [h0, a0, o0] = await licenseSideEffects(licenseId);

    const replay = await h.renew(
      req(operator, { params: { licenseId }, body: { newValidTo: newValidTo.toISOString() } }),
    );
    assert.equal(replay.status, 200);
    assert.equal((replay.body as DataBody).data.replayed, true);
    const [h1, a1, o1] = await licenseSideEffects(licenseId);
    assert.deepEqual([h1, a1, o1], [h0, a0, o0], '回放无新历史/审计/通知');

    const different = await h.renew(
      req(operator, {
        params: { licenseId },
        body: { newValidTo: new Date(NOW.getTime() + 500 * DAY_MS).toISOString() },
      }),
    );
    assert.equal(different.status, 409, '已 Renewed 且目标不一致 → CONFLICT');
    assert.equal((different.body as ErrorBody).error.code, 'CONFLICT');
  });
});

describe('非法路径与边界', () => {
  test('正式列表保留终态 License，并支持状态筛选与键集分页', async () => {
    const { deviceId } = await plantAssignedDevice();
    const h = handlers();
    const first = await createDraft(h, deviceId, new Date(NOW.getTime() + 400 * DAY_MS));
    const firstId = first.licenseId as string;
    await h.issue(req(operator, { params: { licenseId: firstId } }));
    await h.activate(req(operator, { params: { licenseId: firstId } }));
    await h.revoke(req(operator, { params: { licenseId: firstId }, body: { reason: '列表历史验证' } }));
    await createDraft(h, deviceId, new Date(NOW.getTime() + 500 * DAY_MS));

    const page1 = await h.list(req(auditor, { query: { deviceId, limit: '1' } }));
    assert.equal(page1.status, 200);
    assert.equal((page1.body as { data: unknown[] }).data.length, 1);
    const cursor = (page1.body as { meta: { nextCursor: string | null } }).meta.nextCursor;
    assert.ok(cursor);
    const page2 = await h.list(req(auditor, { query: { deviceId, limit: '1', cursor } }));
    assert.equal((page2.body as { data: unknown[] }).data.length, 1);

    const revoked = await h.list(req(auditor, { query: { deviceId, status: 'Revoked' } }));
    const revokedRows = (revoked.body as { data: { licenseId: string; status: string }[] }).data;
    assert.equal(revokedRows.length, 1);
    assert.equal(revokedRows[0]?.licenseId, firstId);
    assert.equal(revokedRows[0]?.status, 'Revoked');
  });

  test('非法迁移 409；缺原因/非法参数 400；evaluate 无变化无写入', async () => {
    const { deviceId } = await plantAssignedDevice();
    const h = handlers();
    const draft = await createDraft(h, deviceId, new Date(NOW.getTime() + 400 * DAY_MS));
    const licenseId = draft.licenseId as string;

    // Draft 上 activate/revoke → 409；revoke 缺原因 → 400
    const actOnDraft = await h.activate(req(operator, { params: { licenseId } }));
    assert.equal(actOnDraft.status, 409);
    assert.equal((actOnDraft.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');
    assert.equal((await h.revoke(req(operator, { params: { licenseId }, body: {} }))).status, 400);
    const revokeDraft = await h.revoke(req(operator, { params: { licenseId }, body: { reason: 'r' } }));
    assert.equal(revokeDraft.status, 409, 'Draft 不可直接吊销');

    // evaluate 对 Draft 无变化：changed=false 且无写入
    const [h0, a0, o0] = await licenseSideEffects(licenseId);
    const evalNoop = await h.evaluate(req(operator, { params: { licenseId }, body: {} }));
    assert.equal(evalNoop.status, 200);
    assert.equal((evalNoop.body as DataBody).data.changed, false);
    const [h1, a1, o1] = await licenseSideEffects(licenseId);
    assert.deepEqual([h1, a1, o1], [h0, a0, o0]);

    // issue → Issued；重复 issue → 409；未到 validFrom 的 activate → 409
    await h.issue(req(operator, { params: { licenseId } }));
    assert.equal((await h.issue(req(operator, { params: { licenseId } }))).status, 409, '重复 issue 非法');

    // Active（未到到期窗口）renew → 409
    await h.activate(req(operator, { params: { licenseId } }));
    const renewActive = await h.renew(
      req(operator, {
        params: { licenseId },
        body: { newValidTo: new Date(NOW.getTime() + 800 * DAY_MS).toISOString() },
      }),
    );
    assert.equal(renewActive.status, 409);
    assert.equal((renewActive.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');

    // 不存在 → 404
    assert.equal((await h.detail(req(operator, { params: { licenseId: 'lic-x' } }))).status, 404);
    assert.equal((await h.history(req(operator, { params: { licenseId: 'lic-x' } }))).status, 404);
  });

  test('activate 要求已到 validFrom（未来生效 → 409）', async () => {
    const { deviceId } = await plantAssignedDevice();
    const h = handlers();
    const futureFrom = new Date(NOW.getTime() + 30 * DAY_MS);
    const res = await h.create(
      req(operator, {
        body: {
          deviceId,
          validFrom: futureFrom.toISOString(),
          validTo: new Date(NOW.getTime() + 400 * DAY_MS).toISOString(),
          entitlements: ['ESG_REPORTING'],
        },
      }),
    );
    const licenseId = (res.body as DataBody).data.licenseId as string;
    await h.issue(req(operator, { params: { licenseId } }));
    const early = await h.activate(req(operator, { params: { licenseId } }));
    assert.equal(early.status, 409, '未到 validFrom 不可激活');
    assert.equal((early.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');
  });

  test('一个设备不能出现两个有效 License；吊销后可重建；创建校验与越权', async () => {
    const { deviceId } = await plantAssignedDevice();
    const h = handlers();
    const draft = await createDraft(h, deviceId, new Date(NOW.getTime() + 400 * DAY_MS));
    const licenseId = draft.licenseId as string;

    // 存在 Draft 时再次创建 → 409（领域拒绝；DB 部分唯一索引兜底 Issued/Active/ExpiringSoon）
    const dup = await h.create(
      req(operator, {
        body: {
          deviceId,
          validFrom: VALID_FROM.toISOString(),
          validTo: new Date(NOW.getTime() + 500 * DAY_MS).toISOString(),
          entitlements: ['REMOTE_CONTROL'],
        },
      }),
    );
    assert.equal(dup.status, 409);
    assert.equal((dup.body as ErrorBody).error.code, 'CONFLICT');

    // 走完生命周期吊销后可重建
    await h.issue(req(operator, { params: { licenseId } }));
    await h.activate(req(operator, { params: { licenseId } }));
    await h.revoke(req(operator, { params: { licenseId }, body: { reason: '终止' } }));
    const recreated = await h.create(
      req(operator, {
        body: {
          deviceId,
          validFrom: VALID_FROM.toISOString(),
          validTo: new Date(NOW.getTime() + 500 * DAY_MS).toISOString(),
          entitlements: ['REMOTE_CONTROL'],
        },
      }),
    );
    assert.equal(recreated.status, 201, '终态后可创建新 Draft');

    // 未分配/已退役/不存在设备
    const unassigned = await plantAssignedDevice({ assigned: false, lifecycle: 'Onboarded' });
    const resUnassigned = await h.create(
      req(operator, {
        body: {
          deviceId: unassigned.deviceId,
          validFrom: VALID_FROM.toISOString(),
          validTo: new Date(NOW.getTime() + 400 * DAY_MS).toISOString(),
          entitlements: ['REMOTE_CONTROL'],
        },
      }),
    );
    assert.equal(resUnassigned.status, 409, '未分配 Customer 的设备不可创建 License');
    const retired = await plantAssignedDevice({ lifecycle: 'Retired' });
    const resRetired = await h.create(
      req(operator, {
        body: {
          deviceId: retired.deviceId,
          validFrom: VALID_FROM.toISOString(),
          validTo: new Date(NOW.getTime() + 400 * DAY_MS).toISOString(),
          entitlements: ['REMOTE_CONTROL'],
        },
      }),
    );
    assert.equal(resRetired.status, 409, '已退役设备不可创建 License');
    assert.equal(
      (
        await h.create(
          req(operator, {
            body: {
              deviceId: 'dev-x',
              validFrom: VALID_FROM.toISOString(),
              validTo: new Date(NOW.getTime() + 400 * DAY_MS).toISOString(),
              entitlements: ['REMOTE_CONTROL'],
            },
          }),
        )
      ).status,
      404,
    );

    // 参数校验：空 entitlements / 未知码 / validFrom>=validTo
    const target = await plantAssignedDevice();
    for (const body of [
      {
        deviceId: target.deviceId,
        validFrom: VALID_FROM.toISOString(),
        validTo: new Date(NOW.getTime() + DAY_MS).toISOString(),
        entitlements: [],
      },
      {
        deviceId: target.deviceId,
        validFrom: VALID_FROM.toISOString(),
        validTo: new Date(NOW.getTime() + DAY_MS).toISOString(),
        entitlements: ['BOGUS'],
      },
      {
        deviceId: target.deviceId,
        validFrom: new Date(NOW.getTime() + DAY_MS).toISOString(),
        validTo: VALID_FROM.toISOString(),
        entitlements: ['REMOTE_CONTROL'],
      },
      {
        deviceId: target.deviceId,
        validFrom: 'not-a-date',
        validTo: new Date(NOW.getTime() + DAY_MS).toISOString(),
        entitlements: ['REMOTE_CONTROL'],
      },
    ]) {
      const res = await h.create(req(operator, { body }));
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
    }

    // 越权：Auditor/Customer 写 → 403；Customer 读 → 403（license:read 不含 Customer 角色）；未认证 → 401
    assert.equal((await h.create(req(auditor, { body: {} }))).status, 403);
    assert.equal((await h.detail(req(customerAdmin, { params: { licenseId } }))).status, 403);
    assert.equal((await h.detail(req(undefined, { params: { licenseId } }))).status, 401);
    assert.equal((await h.issue(req(auditor, { params: { licenseId } }))).status, 403);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminLicenseError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_LICENSE_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('License DTO 字段与 OpenAPI License 契约一致', async () => {
    const api = loadJson('admin-license-api.json');
    const required = [...api.components.schemas.License.required].sort();
    const { deviceId } = await plantAssignedDevice();
    const draft = await createDraft(handlers(), deviceId, new Date(NOW.getTime() + 400 * DAY_MS));
    assert.deepEqual(Object.keys(draft).sort(), required);
    assert.deepEqual((draft.entitlements as { code: string }[]).map((item) => item.code).sort(), [
      'OTA',
      'REMOTE_CONTROL',
    ]);
  });

  test('OpenAPI wire 请求可执行且成功/错误响应反向通过统一 bundle；未知字段和内部码失败关闭', async () => {
    const { deviceId } = await plantAssignedDevice();
    const h = handlers();
    const validBody = {
      deviceId,
      validFrom: VALID_FROM.toISOString(),
      validTo: new Date(NOW.getTime() + 400 * DAY_MS).toISOString(),
      entitlements: ['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING'],
    };
    const success = await h.create(req(operator, { body: validBody }));
    assert.equal(success.status, 201);
    assertOpenApiResponse('createLicense', 201, success.body);

    for (const body of [
      { ...validBody, certificatePem: 'forbidden' },
      { ...validBody, entitlements: ['OTA_UPDATE'] },
      ['not-an-object'],
    ]) {
      const failed = await h.create(req(operator, { body }));
      assert.equal(failed.status, 400);
      assertOpenApiResponse('createLicense', 400, failed.body);
    }
  });

  test('DEC-020 固定向量与 active/previous/legacy 轮换验签语义稳定', () => {
    const payload = {
      licenseId: 'lic-vector-1',
      deviceId: 'dev-vector-1',
      customerId: 'cus-vector-1',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2027-01-01T00:00:00.000Z'),
      entitlements: ['ESG_REPORTING', 'OTA_UPDATE', 'REMOTE_CONTROL'],
    };
    const signature = signLicensePayload('active-test-key', payload);
    assert.equal(signature, 'v1.9m5ypvSu2hLkU-5T3O9PpA7XhLBP42u6-FJiCZ4vhb0');
    assert.isTrue(verifyLicensePayloadSignature({ active: 'active-test-key' }, payload, signature));
    assert.isTrue(
      verifyLicensePayloadSignature({ active: 'new-key', previous: 'active-test-key' }, payload, signature),
    );
    assert.isTrue(
      verifyLicensePayloadSignature(
        { active: 'new-key', previous: 'active-test-key' },
        payload,
        signature.slice('v1.'.length),
      ),
    );
    assert.isFalse(verifyLicensePayloadSignature({ active: 'new-key' }, payload, signature.slice('v1.'.length)));
  });

  test('admin/license 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/license/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
