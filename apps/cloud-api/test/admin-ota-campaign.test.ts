/**
 * BE-OTA-02 OTA Campaign API 与状态机验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 首批超过 1 台被拒绝（0 台/2 台/去重后非 1 台 → 400）；
 * - 坏包/未校验包不可建 Campaign（非 VERIFIED → 400；不存在 → 404）；
 * - 设备资格门：型号不匹配/Suspended/无 License/Entitlement 停用/License 过期 → 400；
 *   Maintenance 放行（DEC-001）；
 * - 最终全量扩批须既有批次全部成功 + PlatformSuperAdmin 显式批准；否则 403/409/400；
 * - 暂停/取消后不得产生新下发（PAUSED/CANCELLED 扩大批次与重试 → 409；取消级联
 *   未完成 target → CANCELLED；SUCCEEDED 不受影响）；
 * - 失败重试：FAILED → PENDING（含指定子集与非法子集 400）；
 * - 每次状态变化有审计：Campaign 各操作写 audit_logs；Target 各变化写
 *   ota_status_history（创建/扩大/取消/重试/ACK 推进每步）；
 * - 状态机：暂停/恢复/取消幂等回放；非法迁移 409；recordTargetStatus（DEC-015 ACK
 *   通道，BE-OTA-03 复用）合法链推进 + 全部 SUCCEEDED 自动 COMPLETED；
 * - 鉴权：无 actor → 401；Customer/Auditor 无 ota:write → 403；Customer 无 ota:read → 403。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminOtaCampaignHandlers, recordTargetStatus } from '../src/index.js';
import type { AdminHttpRequest, AdminOtaCampaignHandlerDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-02T10:00:00Z');
const MODEL = 'BNX-200';

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
  actorId: 'ca-1',
  username: 'ca-1',
  actorType: 'customer',
  roles: ['CustomerAdmin'],
  customerId: 'cust-1',
  tokenUse: 'access',
};

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers(at: Date = NOW) {
  const deps: AdminOtaCampaignHandlerDeps = { client: prisma, now: () => at };
  return createAdminOtaCampaignHandlers(deps);
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return { actor, headers: {}, requestId: `req-${Math.random().toString(36).slice(2)}`, ...options };
}

type DataBody = { data: Record<string, any>; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type ErrBody = { error: { code: string; message: string } };

let seq = 0;

/** 设备 + 有效 License（默认 OTA_UPDATE enabled）。 */
async function plantDevice(
  options: {
    model?: string;
    lifecycleStatus?: string;
    entitlement?: { code: string; enabled: boolean } | null;
    licenseExpired?: boolean;
    noLicense?: boolean;
  } = {},
): Promise<string> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `OTA ${seq}` } });
  const deviceId = `dev-ota-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-OTA-${seq}`,
      model: options.model ?? MODEL,
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      customerId: customer.id,
    },
  });
  if (!options.noLicense) {
    const license = await prisma.license.create({
      data: {
        deviceId,
        customerId: customer.id,
        status: 'Active',
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validTo: options.licenseExpired ? new Date(NOW.getTime() - 1000) : new Date(NOW.getTime() + 86_400_000),
        createdBy: 'test',
      },
    });
    const ent = options.entitlement === undefined ? { code: 'OTA_UPDATE', enabled: true } : options.entitlement;
    if (ent !== null) {
      await prisma.licenseEntitlement.create({ data: { licenseId: license.id, code: ent.code, enabled: ent.enabled } });
    }
  }
  return deviceId;
}

async function plantPackage(options: { model?: string; status?: string } = {}): Promise<string> {
  const pkg = await prisma.firmwarePackage.create({
    data: {
      model: options.model ?? MODEL,
      version: `2.0.${seq}-${randomUUID().slice(0, 8)}`,
      packageType: 'FIRMWARE',
      sha256: createHash('sha256').update(randomUUID()).digest('hex'),
      sizeBytes: 1024,
      s3Key: `firmware-packages/test/${randomUUID()}`,
      signature: 'sig:test',
      status: options.status ?? 'VERIFIED',
      uploadedBy: 'test',
    },
  });
  return pkg.id;
}

/** 创建 RUNNING Campaign（首批 1 台），返回 {campaignId, targetId}。 */
async function plantCampaign(packageId?: string): Promise<{ campaignId: string; deviceId: string }> {
  const deviceId = await plantDevice();
  const pkgId = packageId ?? (await plantPackage());
  const res = await handlers().createCampaign(
    req(operator, { body: { name: `Campaign ${seq}`, packageId: pkgId, deviceIds: [deviceId] } }),
  );
  assert.equal(res.status, 201);
  return { campaignId: (res.body as DataBody).data.campaignId, deviceId };
}

async function targetOf(campaignId: string, deviceId: string) {
  return prisma.otaTarget.findFirst({ where: { campaignId, deviceId } });
}

/** 断言 Promise 以给定消息模式拒绝（vitest assert 无内建 rejects）。 */
async function expectReject(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    assert.match((err as Error).message, pattern);
    return;
  }
  assert.fail(`expected rejection matching ${pattern}`);
}

describe('BE-OTA-02 创建 Campaign（强制首批 1 台）', () => {
  test('鉴权：无 actor → 401；CustomerAdmin/Auditor 无 ota:write → 403', async () => {
    const deviceId = await plantDevice();
    const packageId = await plantPackage();
    const body = { name: 'C', packageId, deviceIds: [deviceId] };
    const h = handlers();
    assert.equal((await h.createCampaign(req(undefined, { body }))).status, 401);
    for (const actor of [customerAdmin, auditor]) {
      const res = await h.createCampaign(req(actor, { body }));
      assert.equal(res.status, 403);
      assert.equal((res.body as ErrBody).error.code, 'FORBIDDEN');
    }
  });

  test('首批必须恰好 1 台：0 台/2 台/去重后非 1 台 → 400', async () => {
    const [d1, d2] = [await plantDevice(), await plantDevice()];
    const packageId = await plantPackage();
    const h = handlers();
    for (const deviceIds of [[], [d1, d2], [d1, d2, d2]]) {
      const res = await h.createCampaign(req(operator, { body: { name: 'C', packageId, deviceIds } }));
      assert.equal(res.status, 400, JSON.stringify(deviceIds));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
      assert.match((res.body as ErrBody).error.message, /exactly 1/);
    }
    // 去重后恰好 1 台（[d1, d1]）放行
    const ok = await h.createCampaign(req(operator, { body: { name: 'C', packageId, deviceIds: [d1, d1] } }));
    assert.equal(ok.status, 201);
  });

  test('坏包/未校验包不可建 Campaign：包不存在 → 404；UPLOADED → 400', async () => {
    const deviceId = await plantDevice();
    const h = handlers();
    const missing = await h.createCampaign(
      req(operator, { body: { name: 'C', packageId: 'pkg-unknown', deviceIds: [deviceId] } }),
    );
    assert.equal(missing.status, 404);
    const uploadedPkg = await plantPackage({ status: 'UPLOADED' });
    const unverified = await h.createCampaign(
      req(operator, { body: { name: 'C', packageId: uploadedPkg, deviceIds: [deviceId] } }),
    );
    assert.equal(unverified.status, 400);
    assert.match((unverified.body as ErrBody).error.message, /VERIFIED/);
  });

  test('设备资格门：不存在/型号不匹配/Suspended/无 License/Entitlement 停用/License 过期 → 400；Maintenance 放行', async () => {
    const h = handlers();
    const packageId = await plantPackage();
    const cases: Array<[Record<string, unknown>, Parameters<typeof plantDevice>[0]]> = [
      [{ packageId, deviceIds: ['dev-ghost'] }, {}],
      [{ packageId }, { model: 'BNX-OTHER' }],
      [{ packageId }, { lifecycleStatus: 'Suspended' }],
      [{ packageId }, { lifecycleStatus: 'Retired' }],
      [{ packageId }, { noLicense: true }],
      [{ packageId }, { entitlement: { code: 'OTA_UPDATE', enabled: false } }],
      [{ packageId }, { entitlement: { code: 'REMOTE_CONTROL', enabled: true } }],
      [{ packageId }, { licenseExpired: true }],
    ];
    for (const [bodyOverride, deviceOptions] of cases) {
      const deviceId = (bodyOverride.deviceIds as string[] | undefined)?.[0] ?? (await plantDevice(deviceOptions));
      const res = await h.createCampaign(
        req(operator, { body: { name: 'C', packageId, deviceIds: [deviceId], ...bodyOverride } }),
      );
      assert.equal(res.status, 400, JSON.stringify(deviceOptions));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    // Maintenance 允许 OTA（DEC-001）
    const maintenanceDevice = await plantDevice({ lifecycleStatus: 'Maintenance' });
    const ok = await h.createCampaign(
      req(operator, { body: { name: 'C', packageId, deviceIds: [maintenanceDevice] } }),
    );
    assert.equal(ok.status, 201);
  });

  test('成功：201 RUNNING + 首批 target batchNo=1 PENDING + 历史 + 审计 + targetModel 取自包', async () => {
    const deviceId = await plantDevice();
    const packageId = await plantPackage();
    const res = await handlers().createCampaign(
      req(operator, { body: { name: '  Canary 1  ', packageId, deviceIds: [deviceId] } }),
    );
    assert.equal(res.status, 201);
    const view = (res.body as DataBody).data;
    assert.equal(view.status, 'RUNNING');
    assert.equal(view.name, 'Canary 1');
    assert.equal(view.targetModel, MODEL);
    assert.equal(view.strategy, 'CANARY');
    assert.equal(view.createdBy, operator.actorId);
    assert.equal(view.packageId, packageId);

    const target = await targetOf(view.campaignId, deviceId);
    assert.equal(target?.batchNo, 1);
    assert.equal(target?.status, 'PENDING');
    const history = await prisma.otaStatusHistory.findMany({ where: { targetId: target!.id } });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.fromStatus, null);
    assert.equal(history[0]?.toStatus, 'PENDING');

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'ota_campaign', objectId: view.campaignId, action: 'ota.campaign.create' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, operator.actorId);
  });
});

describe('BE-OTA-02 扩大批次', () => {
  test('仅 RUNNING 可扩大：PAUSED/CANCELLED → 409；不存在 → 404', async () => {
    const { campaignId } = await plantCampaign();
    const h = handlers();
    await h.pauseCampaign(req(operator, { params: { campaignId } }));
    const extra = await plantDevice();
    const paused = await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [extra] } }));
    assert.equal(paused.status, 409);
    assert.equal((paused.body as ErrBody).error.code, 'CONFLICT');

    await h.resumeCampaign(req(operator, { params: { campaignId } }));
    await h.cancelCampaign(req(operator, { params: { campaignId } }));
    const cancelled = await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [extra] } }));
    assert.equal(cancelled.status, 409);

    const missing = await h.expandBatch(
      req(operator, { params: { campaignId: 'c-unknown' }, body: { deviceIds: [extra] } }),
    );
    assert.equal(missing.status, 404);
  });

  test('空列表/重复去重后空 → 400；非法设备 → 400；已在 Campaign 的设备幂等跳过', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    const h = handlers();
    assert.equal((await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [] } }))).status, 400);

    const ghost = await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: ['dev-ghost'] } }));
    assert.equal(ghost.status, 400);

    // 幂等：已在 Campaign 的设备跳过；同请求重复去重
    const extra = await plantDevice();
    const res = await h.expandBatch(
      req(operator, { params: { campaignId }, body: { deviceIds: [deviceId, extra, extra] } }),
    );
    assert.equal(res.status, 201);
    const result = (res.body as DataBody).data;
    assert.equal(result.batchNo, 2);
    assert.equal(result.addedCount, 1);
    assert.equal(result.skippedExistingCount, 1);
    assert.equal(result.addedTargets.length, 1);
    assert.equal(result.addedTargets[0].deviceId, extra);
    assert.equal(result.addedTargets[0].status, 'PENDING');
    assert.equal(result.addedTargets[0].batchNo, 2);

    const history = await prisma.otaStatusHistory.findMany({ where: { targetId: result.addedTargets[0].targetId } });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.toStatus, 'PENDING');
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'ota_campaign', objectId: campaignId, action: 'ota.campaign.expand' },
    });
    assert.equal(audits.length, 1);
  });

  test('最终全量扩批：灰度成功后仅 SuperAdmin 可显式批准；无审批/过早/越权均失败关闭', async () => {
    // 型号独占：该型号恰好 2 台合格设备
    const model = `BNX-FULL-${seq}`;
    const d1 = await plantDevice({ model });
    const d2 = await plantDevice({ model });
    // 一台不合格（Suspended）不计入合格集合
    await plantDevice({ model, lifecycleStatus: 'Suspended' });
    const packageId = await plantPackage({ model });
    const h = handlers();

    const create = await h.createCampaign(req(operator, { body: { name: 'C', packageId, deviceIds: [d1] } }));
    assert.equal(create.status, 201);
    const campaignId = (create.body as DataBody).data.campaignId;
    const approval = { confirmText: `APPROVE_FINAL_ROLLOUT:${campaignId}` };

    const premature = await h.expandBatch(
      req(superAdmin, {
        params: { campaignId },
        body: { deviceIds: [d2], finalRolloutApproval: approval },
      }),
    );
    assert.equal(premature.status, 409, '灰度未成功不得批准最终扩批');

    const canary = await targetOf(campaignId, d1);
    for (const status of ['NOTIFIED', 'DOWNLOADING', 'INSTALLING', 'SUCCEEDED']) {
      await recordTargetStatus({ client: prisma }, canary!.id, status);
    }
    assert.equal((await prisma.otaCampaign.findUnique({ where: { id: campaignId } }))?.status, 'RUNNING');

    const unauthorized = await h.expandBatch(
      req(operator, {
        params: { campaignId },
        body: { deviceIds: [d2], finalRolloutApproval: approval },
      }),
    );
    assert.equal(unauthorized.status, 403);
    const missing = await h.expandBatch(req(superAdmin, { params: { campaignId }, body: { deviceIds: [d2] } }));
    assert.equal(missing.status, 400);
    const wrong = await h.expandBatch(
      req(superAdmin, {
        params: { campaignId },
        body: { deviceIds: [d2], finalRolloutApproval: { confirmText: 'APPROVE' } },
      }),
    );
    assert.equal(wrong.status, 400);
    const clientTimestamp = await h.expandBatch(
      req(superAdmin, {
        params: { campaignId },
        body: {
          deviceIds: [d2],
          finalRolloutApproval: { ...approval, confirmedAt: NOW.toISOString() },
        },
      }),
    );
    assert.equal(clientTimestamp.status, 400, '审批事实不接受客户端时间或其他未冻结字段');

    const approved = await h.expandBatch(
      req(superAdmin, {
        params: { campaignId },
        body: { deviceIds: [d2], finalRolloutApproval: approval },
      }),
    );
    assert.equal(approved.status, 201);
    assert.equal((approved.body as DataBody).data.finalRolloutApproved, true);
    assert.equal((approved.body as DataBody).data.approvedBy, superAdmin.actorId);
    const row = await prisma.otaCampaign.findUnique({ where: { id: campaignId } });
    assert.equal(row?.finalRolloutApprovedBy, superAdmin.actorId);
    assert.equal(row?.finalRolloutEligibleCount, 2);
    assert.equal(row?.strategy, 'BATCH');

    const finalTarget = await targetOf(campaignId, d2);
    for (const status of ['NOTIFIED', 'DOWNLOADING', 'INSTALLING', 'SUCCEEDED']) {
      await recordTargetStatus({ client: prisma }, finalTarget!.id, status);
    }
    assert.equal((await prisma.otaCampaign.findUnique({ where: { id: campaignId } }))?.status, 'COMPLETED');
    const audit = await prisma.auditLog.findFirst({
      where: { objectId: campaignId, action: 'ota.campaign.expand', actorId: superAdmin.actorId },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal((audit?.afterValue as Record<string, unknown>).finalRolloutApproved, true);
  });
});

describe('BE-OTA-02 暂停/恢复/取消', () => {
  test('暂停 → 恢复：RUNNING⇄PAUSED + 每次审计；幂等回放；终态 409', async () => {
    const { campaignId } = await plantCampaign();
    const h = handlers();

    const paused = await h.pauseCampaign(req(superAdmin, { params: { campaignId } }));
    assert.equal(paused.status, 200);
    assert.equal((paused.body as DataBody).data.status, 'PAUSED');
    // 幂等回放：重复暂停 200 且无新审计
    const again = await h.pauseCampaign(req(superAdmin, { params: { campaignId } }));
    assert.equal(again.status, 200);
    assert.equal(await prisma.auditLog.count({ where: { objectId: campaignId, action: 'ota.campaign.pause' } }), 1);

    const resumed = await h.resumeCampaign(req(superAdmin, { params: { campaignId } }));
    assert.equal(resumed.status, 200);
    assert.equal((resumed.body as DataBody).data.status, 'RUNNING');

    // 取消后暂停 → 409
    await h.cancelCampaign(req(superAdmin, { params: { campaignId } }));
    const res = await h.pauseCampaign(req(superAdmin, { params: { campaignId } }));
    assert.equal(res.status, 409);
    const actions = (
      await prisma.auditLog.findMany({ where: { objectType: 'ota_campaign', objectId: campaignId } })
    ).map((a) => a.action);
    assert.deepEqual(actions.sort(), [
      'ota.campaign.cancel',
      'ota.campaign.create',
      'ota.campaign.pause',
      'ota.campaign.resume',
    ]);
  });

  test('取消：级联未完成 target → CANCELLED + 每台历史；SUCCEEDED 保留；幂等回放；COMPLETED → 409', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    const h = handlers();
    // 推进首批到 INSTALLING；再扩大 1 台（PENDING）
    const t1 = await targetOf(campaignId, deviceId);
    await recordTargetStatus({ client: prisma }, t1!.id, 'NOTIFIED');
    await recordTargetStatus({ client: prisma }, t1!.id, 'DOWNLOADING');
    await recordTargetStatus({ client: prisma }, t1!.id, 'INSTALLING');
    const extra = await plantDevice();
    await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [extra] } }));
    // 第三台已成功（SUCCEEDED 终态不受取消影响）
    const done = await plantDevice();
    await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [done] } }));
    const t3 = await targetOf(campaignId, done);
    await recordTargetStatus({ client: prisma }, t3!.id, 'NOTIFIED');
    await recordTargetStatus({ client: prisma }, t3!.id, 'DOWNLOADING');
    await recordTargetStatus({ client: prisma }, t3!.id, 'INSTALLING');
    await recordTargetStatus({ client: prisma }, t3!.id, 'SUCCEEDED');

    const res = await h.cancelCampaign(req(operator, { params: { campaignId } }));
    assert.equal(res.status, 200);
    assert.equal((res.body as DataBody).data.status, 'CANCELLED');

    const all = await prisma.otaTarget.findMany({ where: { campaignId } });
    const byStatus = Object.fromEntries(all.map((t) => [t.deviceId, t.status]));
    assert.equal(byStatus[deviceId], 'CANCELLED', 'INSTALLING 级联取消');
    assert.equal(byStatus[extra], 'CANCELLED', 'PENDING 级联取消');
    assert.equal(byStatus[done], 'SUCCEEDED', '终态不受影响');

    const t1History = await prisma.otaStatusHistory.findMany({ where: { targetId: t1!.id } });
    assert.deepEqual(
      t1History.map((x) => `${x.fromStatus ?? 'null'}→${x.toStatus}`).sort(),
      [
        'null→PENDING',
        'PENDING→NOTIFIED',
        'NOTIFIED→DOWNLOADING',
        'DOWNLOADING→INSTALLING',
        'INSTALLING→CANCELLED',
      ].sort(),
    );

    // 幂等回放：重复取消 200
    assert.equal((await h.cancelCampaign(req(operator, { params: { campaignId } }))).status, 200);
    // 取消后不得产生新下发：扩大/重试 → 409
    const another = await plantDevice();
    assert.equal(
      (await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [another] } }))).status,
      409,
    );
    assert.equal((await h.retryCampaign(req(operator, { params: { campaignId }, body: {} }))).status, 409);
  });
});

describe('BE-OTA-02 失败重试', () => {
  test('FAILED → PENDING（全部/指定子集）+ 历史 + 审计；非法子集 → 400；仅 RUNNING', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    const h = handlers();
    const extra = await plantDevice();
    await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [extra] } }));
    const t1 = await targetOf(campaignId, deviceId);
    const t2 = await targetOf(campaignId, extra);
    // 两台都推进到 FAILED
    for (const t of [t1!, t2!]) {
      await recordTargetStatus({ client: prisma }, t.id, 'NOTIFIED');
      await recordTargetStatus({ client: prisma }, t.id, 'DOWNLOADING');
      await recordTargetStatus({ client: prisma }, t.id, 'FAILED');
    }

    // 指定子集重试
    const partial = await h.retryCampaign(req(operator, { params: { campaignId }, body: { targetIds: [t1!.id] } }));
    assert.equal(partial.status, 200);
    assert.deepEqual((partial.body as DataBody).data.retriedTargetIds, [t1!.id]);
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: t1!.id } }))?.status, 'PENDING');
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: t2!.id } }))?.status, 'FAILED');

    // 非法子集：非 FAILED / 不属于本 Campaign → 400
    const bad = await h.retryCampaign(req(operator, { params: { campaignId }, body: { targetIds: [t1!.id] } }));
    assert.equal(bad.status, 400, 't1 已非 FAILED');
    const bad2 = await h.retryCampaign(req(operator, { params: { campaignId }, body: { targetIds: ['t-unknown'] } }));
    assert.equal(bad2.status, 400);

    // 全量重试
    const all = await h.retryCampaign(req(operator, { params: { campaignId }, body: {} }));
    assert.equal(all.status, 200);
    assert.deepEqual((all.body as DataBody).data.retriedTargetIds, [t2!.id]);
    const t2History = await prisma.otaStatusHistory.findMany({ where: { targetId: t2!.id } });
    assert.ok(t2History.some((x) => x.fromStatus === 'FAILED' && x.toStatus === 'PENDING'));
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'ota_campaign', objectId: campaignId, action: 'ota.campaign.retry' },
    });
    assert.equal(audits.length, 2);

    // 无 FAILED → retriedCount 0（仍 200）
    const none = await h.retryCampaign(req(operator, { params: { campaignId }, body: {} }));
    assert.equal(none.status, 200);
    assert.equal((none.body as DataBody).data.retriedCount, 0);
  });
});

describe('BE-OTA-02 recordTargetStatus（DEC-015 ACK 通道，BE-OTA-03 复用）', () => {
  test('合法链推进 + 每步历史；非法迁移 → 409；幂等回放不重复写历史；未知状态 → 400', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    const t1 = await targetOf(campaignId, deviceId);
    const deps = { client: prisma };

    assert.equal((await recordTargetStatus(deps, t1!.id, 'NOTIFIED')).status, 'NOTIFIED');
    // 幂等回放：重复 NOTIFIED 不新增历史
    await recordTargetStatus(deps, t1!.id, 'NOTIFIED');
    assert.equal(await prisma.otaStatusHistory.count({ where: { targetId: t1!.id } }), 2);
    // 非法迁移：NOTIFIED → SUCCEEDED → 409
    await expectReject(recordTargetStatus(deps, t1!.id, 'SUCCEEDED'), /Illegal target transition/);
    // 未知状态 → 400
    await expectReject(recordTargetStatus(deps, t1!.id, 'BRICKED'), /Unknown target status/);
    // 不存在 → 404
    await expectReject(recordTargetStatus(deps, 't-unknown', 'NOTIFIED'), /not found/);

    await recordTargetStatus(deps, t1!.id, 'DOWNLOADING');
    await recordTargetStatus(deps, t1!.id, 'INSTALLING');
    const done = await recordTargetStatus(deps, t1!.id, 'SUCCEEDED');
    assert.ok(done.completedAt, '终态写 completedAt');
    const history = await prisma.otaStatusHistory.findMany({ where: { targetId: t1!.id } });
    assert.equal(history.length, 5, '每次状态变化一条历史');
    assert.equal(
      (await prisma.otaCampaign.findUnique({ where: { id: campaignId } }))?.status,
      'RUNNING',
      '仅灰度成功不得过早完成，须保留最终扩批入口',
    );
  });

  test('未经最终全量审批时，即使当前 targets 全部 SUCCEEDED 也保持 RUNNING', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    const extra = await plantDevice();
    await handlers().expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [extra] } }));
    const deps = { client: prisma };
    const t1 = await targetOf(campaignId, deviceId);
    const t2 = await targetOf(campaignId, extra);
    for (const s of ['NOTIFIED', 'DOWNLOADING', 'FAILED']) await recordTargetStatus(deps, t1!.id, s);
    for (const s of ['NOTIFIED', 'DOWNLOADING', 'INSTALLING', 'SUCCEEDED']) await recordTargetStatus(deps, t2!.id, s);
    // t1 FAILED 未解决 → 不完成
    assert.equal((await prisma.otaCampaign.findUnique({ where: { id: campaignId } }))?.status, 'RUNNING');
    // 重试 t1 并完成后仍不得冒充最终全量完成
    await handlers().retryCampaign(req(operator, { params: { campaignId }, body: {} }));
    for (const s of ['NOTIFIED', 'DOWNLOADING', 'INSTALLING', 'SUCCEEDED']) await recordTargetStatus(deps, t1!.id, s);
    assert.equal((await prisma.otaCampaign.findUnique({ where: { id: campaignId } }))?.status, 'RUNNING');
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'ota_campaign', objectId: campaignId, action: 'ota.campaign.complete' },
    });
    assert.equal(audits.length, 0);
  });
});

describe('BE-OTA-02 查询', () => {
  test('列表筛选 + 详情 targetCounts + targets 筛选/分页；Customer 角色 → 403；404', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    const h = handlers();
    const extra = await plantDevice();
    await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [extra] } }));

    const list = await h.listCampaigns(req(auditor, { query: { status: 'RUNNING', targetModel: MODEL } }));
    assert.ok((list.body as ListBody).data.some((c) => c.campaignId === campaignId));
    assert.equal((await h.listCampaigns(req(auditor, { query: { status: 'BOGUS' } }))).status, 400);

    const detail = await h.getCampaign(req(auditor, { params: { campaignId } }));
    assert.equal(detail.status, 200);
    const d = (detail.body as DataBody).data;
    assert.equal(d.targetCounts.total, 2);
    assert.equal(d.targetCounts.PENDING, 2);
    assert.equal(d.targetCounts.SUCCEEDED, 0);
    assert.equal((await h.getCampaign(req(auditor, { params: { campaignId: 'c-unknown' } }))).status, 404);

    const targets1 = await h.listTargets(req(auditor, { params: { campaignId }, query: { batchNo: '1' } }));
    assert.deepEqual(
      (targets1.body as ListBody).data.map((t) => t.deviceId),
      [deviceId],
    );
    const page1 = await h.listTargets(req(auditor, { params: { campaignId }, query: { limit: '1' } }));
    assert.equal((page1.body as ListBody).data.length, 1);
    assert.ok((page1.body as ListBody).meta.nextCursor);
    const page2 = await h.listTargets(
      req(auditor, { params: { campaignId }, query: { limit: '1', cursor: (page1.body as ListBody).meta.nextCursor } }),
    );
    assert.equal((page2.body as ListBody).data.length, 1);
    assert.notEqual((page1.body as ListBody).data[0].targetId, (page2.body as ListBody).data[0].targetId);
    assert.equal(
      (await h.listTargets(req(auditor, { params: { campaignId }, query: { status: 'BOGUS' } }))).status,
      400,
    );
    assert.equal((await h.listTargets(req(auditor, { params: { campaignId: 'c-unknown' } }))).status, 404);

    // Customer 角色无 ota:read → 403
    assert.equal((await h.listCampaigns(req(customerAdmin, { query: {} }))).status, 403);
    assert.equal((await h.getCampaign(req(customerAdmin, { params: { campaignId } }))).status, 403);
  });
});
