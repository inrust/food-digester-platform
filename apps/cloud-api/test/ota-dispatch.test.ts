/**
 * BE-OTA-03 OTA MQTT 下发与状态接收验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 15 分钟（900s）预签名下载 URL，过期时点精确；URL 与目标设备/包绑定（只投递目标
 *   设备 Topic + URL 内嵌包 objectKey；非目标设备收不到 OTA 消息）；
 * - Payload 符合 CT-03 ota.schema.json（version/packageType/downloadUrl/sha256/mandatory/
 *   scheduledTime，meta.id=otaTargetId 幂等键）；
 * - 仅 RUNNING + PENDING + 到期 target 下发；暂停/取消/包非 VERIFIED/Retired 设备/未到期
 *   不产生新下发；MQTT 失败保持 PENDING，重投以稳定 meta.id 幂等；
 * - DEC-015 唯一通道：objectType=OTA_TARGET + otaTargetId；COMMAND 移交（handled=false）；
 *   COMMAND 字段混带拒绝；状态集合封闭；状态迁移合法；重复上报幂等；设备不匹配拒绝；
 * - DEC-016：每次下发写 PUBLICATION、每次被接受的 ACK 写 RESULT（OPERATION_RECORD）；
 *   幂等重放不重复归档；
 * - 取消后设备获得正确 Notification（OTA_CANCELLED，action=CANCEL_PENDING_OTA；
 *   未通知过的 PENDING 设备不发取消通知）；
 * - 不存在第二条未登记回传通道（topic-catalog：ota 仅下行，无 ota/status 上行 Topic）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  OTA_DOWNLOAD_URL_TTL_SECONDS,
  buildOtaPayload,
  createAdminOtaCampaignHandlers,
  dispatchOtaCampaign,
  handleOtaAck,
  otaMessageIdOf,
  otaTopicOf,
  redeemOtaDownloadGrant,
} from '../src/index.js';
import type { AdminHttpRequest, OtaPublisherDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';
// @ts-expect-error -- contracts/mqtt/validator.mjs 为无类型声明的 ESM 校验器（CT 测试专用）
import { SchemaRegistry, validate } from '../../../contracts/mqtt/validator.mjs';

const otaSchema = JSON.parse(
  readFileSync(new URL('../../../contracts/mqtt/schemas/ota.schema.json', import.meta.url), 'utf8'),
);
const topicCatalog = JSON.parse(
  readFileSync(new URL('../../../contracts/mqtt/topic-catalog.json', import.meta.url), 'utf8'),
);

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-02T12:00:00Z');
const MODEL = 'BNX-300';

const operator: ActorContext = {
  actorId: 'op-1',
  username: 'op',
  actorType: 'platform',
  roles: ['PlatformOperator'],
  customerId: null,
  tokenUse: 'access',
};

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

let seq = 0;

async function plantDevice(options: { lifecycleStatus?: string; scheduledModel?: string } = {}): Promise<string> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `OTA3 ${seq}` } });
  const deviceId = `dev-ota3-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-OTA3-${seq}`,
      model: options.scheduledModel ?? MODEL,
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      customerId: customer.id,
    },
  });
  const license = await prisma.license.create({
    data: {
      deviceId,
      customerId: customer.id,
      status: 'Active',
      validFrom: new Date(NOW.getTime() - 86_400_000),
      validTo: new Date(NOW.getTime() + 86_400_000),
      createdBy: 'test',
    },
  });
  await prisma.licenseEntitlement.create({ data: { licenseId: license.id, code: 'OTA_UPDATE', enabled: true } });
  return deviceId;
}

async function plantPackage(options: { status?: string } = {}) {
  return prisma.firmwarePackage.create({
    data: {
      model: MODEL,
      version: `3.0.${seq}-${randomUUID().slice(0, 8)}`,
      packageType: 'FIRMWARE',
      sha256: createHash('sha256').update(randomUUID()).digest('hex'),
      sizeBytes: 2048,
      s3Key: `firmware-packages/${MODEL}/FIRMWARE/v/${randomUUID()}`,
      signature: 'sig:test',
      status: options.status ?? 'VERIFIED',
      uploadedBy: 'test',
    },
  });
}

function req(actor: ActorContext, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return { actor, headers: {}, requestId: `req-${Math.random().toString(36).slice(2)}`, ...options };
}

/** 创建 RUNNING Campaign（首批 1 台 PENDING）。 */
async function plantCampaign(): Promise<{ campaignId: string; deviceId: string; packageId: string }> {
  const deviceId = await plantDevice();
  const pkg = await plantPackage();
  const h = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
  const res = await h.createCampaign(
    req(operator, { body: { name: `C3 ${seq}`, packageId: pkg.id, deviceIds: [deviceId] } }),
  );
  assert.equal(res.status, 201);
  const data = (res.body as { data: Record<string, unknown> }).data;
  return { campaignId: data.campaignId as string, deviceId, packageId: pkg.id };
}

function fakePorts(options: { failMqtt?: boolean } = {}) {
  const published: { topic: string; payload: string; qos: number }[] = [];
  const deps: OtaPublisherDeps = {
    client: prisma,
    now: () => NOW,
    mqtt: {
      async publish(input: { topic: string; payload: string; qos: 1 }) {
        if (options.failMqtt) throw new Error('iot data plane unavailable');
        published.push(input);
      },
    },
    downloadGrantBaseUrl: 'https://device-api.test',
    newLeaseToken: () => `lease-${randomUUID()}`,
    newDownloadToken: () => randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
  };
  return { deps, published };
}

async function expandWith(campaignId: string, deviceId: string) {
  const h = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
  const res = await h.expandBatch(req(operator, { params: { campaignId }, body: { deviceIds: [deviceId] } }));
  assert.equal(res.status, 201);
}

async function rejectsWithCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

describe('BE-OTA-03 OTA 下发（Publisher）', () => {
  test('成功下发：OTA Topic + CT-03 载荷（schema 校验）+ 15 分钟 URL + NOTIFIED + 历史 + OTA_AVAILABLE + PUBLICATION 归档', async () => {
    const { campaignId, deviceId, packageId } = await plantCampaign();
    const { deps, published } = fakePorts();
    const result = await dispatchOtaCampaign(deps, campaignId);

    assert.equal(result.publishedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(published.length, 1);
    // 设备绑定：只投递目标设备 Topic
    assert.equal(published[0]?.topic, otaTopicOf(deviceId));
    assert.equal(published[0]?.qos, 1);

    // Payload 符合 CT-03 ota.schema.json
    const payload = JSON.parse(published[0]!.payload) as Record<string, any>;
    const registry = new SchemaRegistry(
      dirname(fileURLToPath(new URL('../../../contracts/mqtt/schemas/x', import.meta.url))),
    );
    assert.deepEqual(validate(otaSchema, 'ota.schema.json', payload, registry), []);
    const target = await prisma.otaTarget.findFirst({ where: { campaignId, deviceId } });
    const pkg = await prisma.firmwarePackage.findUnique({ where: { id: packageId } });
    // meta.id 由 otaTargetId 派生；URL 是 mTLS Device API 一次性 grant，不暴露 S3 key
    assert.equal(payload.meta.id, otaMessageIdOf(target!.id));
    assert.equal(payload.data.version, pkg!.version);
    assert.equal(payload.data.packageType, 'FIRMWARE');
    assert.equal(payload.data.sha256, pkg!.sha256);
    assert.equal(payload.data.mandatory, false);
    assert.ok(payload.data.downloadUrl.startsWith('https://'));
    const grantUrl = new URL(payload.data.downloadUrl);
    assert.equal(grantUrl.origin, 'https://device-api.test');
    assert.equal(grantUrl.pathname, `/api/v1/device/ota/targets/${target!.id}/download`);
    assert.ok(grantUrl.searchParams.get('token'));
    assert.ok(!payload.data.downloadUrl.includes(pkg!.s3Key), 'MQTT 不携带普通 S3 bearer URL/object key');
    const grant = await prisma.otaDownloadGrant.findFirstOrThrow({ where: { targetId: target!.id } });
    assert.equal(grant.deviceId, deviceId);
    assert.equal(grant.packageId, packageId);
    assert.equal(
      grant.expiresAt.toISOString(),
      new Date(NOW.getTime() + OTA_DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    );
    assert.notEqual(grant.tokenHash, grantUrl.searchParams.get('token'), '数据库只保存 token hash');

    // 状态机：PENDING → NOTIFIED + 历史
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: target!.id } }))?.status, 'NOTIFIED');
    const history = await prisma.otaStatusHistory.findMany({ where: { targetId: target!.id } });
    assert.ok(history.some((x) => x.fromStatus === 'PENDING' && x.toStatus === 'NOTIFIED'));

    // OTA_AVAILABLE 通知（Outbox，deviceAction=AWAIT_OTA_MESSAGE）
    const notifications = await prisma.outboxEvent.findMany({
      where: { eventType: 'OTA_AVAILABLE', aggregateId: target!.id },
    });
    assert.equal(notifications.length, 1);
    const np = notifications[0]?.payload as Record<string, any>;
    assert.equal(np.topic, `bnx/device/${deviceId}/notification`);
    assert.deepEqual(np.data, { type: 'OTA_AVAILABLE', action: 'AWAIT_OTA_MESSAGE' });

    // DEC-016 PUBLICATION 归档
    const archives = await prisma.outboxEvent.findMany({ where: { eventType: 'ARCHIVE', aggregateId: target!.id } });
    assert.equal(archives.length, 1);
    const ap = archives[0]?.payload as Record<string, any>;
    assert.equal(ap.archiveClass, 'OPERATION_RECORD');
    assert.equal(ap.envelopeVersion, '1.0');
    assert.equal(ap.operationType, 'ota');
    assert.equal(ap.recordType, 'PUBLICATION');
    assert.equal(ap.aggregateId, target!.id);
    assert.equal(ap.deviceId, deviceId);
    assert.ok(ap.customerId, '归档须含 customerId');
    assert.equal(ap.data.campaignId, campaignId);
  });

  test('暂停/取消/包非 VERIFIED/Retired 设备/未到期 → 不产生新下发', async () => {
    // 暂停
    const c1 = await plantCampaign();
    const h = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
    await h.pauseCampaign(req(operator, { params: { campaignId: c1.campaignId } }));
    const p1 = fakePorts();
    assert.equal((await dispatchOtaCampaign(p1.deps, c1.campaignId)).publishedCount, 0);
    assert.equal(p1.published.length, 0);
    assert.equal(
      (await prisma.otaTarget.findFirst({ where: { campaignId: c1.campaignId } }))?.status,
      'PENDING',
      '暂停后 target 不被推进',
    );

    // 取消
    const c2 = await plantCampaign();
    await h.cancelCampaign(req(operator, { params: { campaignId: c2.campaignId } }));
    const p2 = fakePorts();
    assert.equal((await dispatchOtaCampaign(p2.deps, c2.campaignId)).publishedCount, 0);
    assert.equal(p2.published.length, 0);

    // 包被 RETIRED
    const c3 = await plantCampaign();
    await prisma.firmwarePackage.update({ where: { id: c3.packageId }, data: { status: 'RETIRED' } });
    const p3 = fakePorts();
    assert.equal((await dispatchOtaCampaign(p3.deps, c3.campaignId)).publishedCount, 0);
    assert.equal(p3.published.length, 0);

    // Retired 设备（资格在创建时校验；下发时二次防护）
    const c4 = await plantCampaign();
    await prisma.device.update({ where: { id: c4.deviceId }, data: { lifecycleStatus: 'Retired' } });
    const p4 = fakePorts();
    const r4 = await dispatchOtaCampaign(p4.deps, c4.campaignId);
    assert.equal(r4.publishedCount, 0);
    assert.equal(r4.skippedCount, 1);
    assert.equal(r4.results[0]?.reason, 'NOT_CLAIMED');
    assert.equal(p4.published.length, 0);

    // scheduledTime 未到期
    const c5 = await plantCampaign();
    await prisma.otaTarget.updateMany({
      where: { campaignId: c5.campaignId },
      data: { scheduledTime: new Date(NOW.getTime() + 3_600_000) },
    });
    const p5 = fakePorts();
    const r5 = await dispatchOtaCampaign(p5.deps, c5.campaignId);
    assert.equal(r5.publishedCount, 0);
    assert.equal(r5.results[0]?.reason, 'NOT_DUE');
    assert.equal(p5.published.length, 0);
  });

  test('MQTT 失败保持 PENDING；重投成功且 meta.id 稳定（幂等键不变）', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    const failing = fakePorts({ failMqtt: true });
    const r1 = await dispatchOtaCampaign(failing.deps, campaignId);
    assert.equal(r1.failedCount, 1);
    assert.equal((await prisma.otaTarget.findFirst({ where: { campaignId, deviceId } }))?.status, 'PENDING');

    const ok = fakePorts();
    const r2 = await dispatchOtaCampaign(ok.deps, campaignId);
    assert.equal(r2.publishedCount, 1);
    const target = await prisma.otaTarget.findFirst({ where: { campaignId, deviceId } });
    assert.equal(JSON.parse(ok.published[0]!.payload).meta.id, otaMessageIdOf(target!.id));
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: target!.id } }))?.status, 'NOTIFIED');
    // 再次调度：NOTIFIED 不再下发（无重复投递）
    const p3 = fakePorts();
    assert.equal((await dispatchOtaCampaign(p3.deps, campaignId)).publishedCount, 0);
    assert.equal(p3.published.length, 0);
  });

  test('多批次：首批 NOTIFIED 后扩大批次，仅新 PENDING 被下发；不存在 Campaign → 404', async () => {
    const { campaignId } = await plantCampaign();
    const p1 = fakePorts();
    await dispatchOtaCampaign(p1.deps, campaignId);
    assert.equal(p1.published.length, 1);

    const extra = await plantDevice();
    await expandWith(campaignId, extra);
    const p2 = fakePorts();
    const r2 = await dispatchOtaCampaign(p2.deps, campaignId);
    assert.equal(r2.publishedCount, 1);
    assert.equal(p2.published.length, 1);
    assert.equal(p2.published[0]?.topic, otaTopicOf(extra), '仅新批次设备收到下发');

    await assertRejectsNotFound(dispatchOtaCampaign(fakePorts().deps, 'c-unknown'));
  });

  test('buildOtaPayload：scheduledTime 为空时省略该字段（schema additionalProperties=false）', () => {
    const withTime = JSON.parse(
      buildOtaPayload({
        targetId: 't1',
        version: '1.0.0',
        packageType: 'APP',
        downloadUrl: 'https://x.test/k',
        sha256: 'a'.repeat(64),
        mandatory: false,
        scheduledTime: NOW,
        at: NOW,
      }),
    );
    assert.equal(withTime.data.scheduledTime, NOW.toISOString());
    const without = JSON.parse(
      buildOtaPayload({
        targetId: 't1',
        version: '1.0.0',
        packageType: 'APP',
        downloadUrl: 'https://x.test/k',
        sha256: 'a'.repeat(64),
        mandatory: false,
        scheduledTime: null,
        at: NOW,
      }),
    );
    assert.ok(!('scheduledTime' in without.data));
  });

  test('并发 dispatcher 只有一个 lease owner 发布；过期 lease 可恢复', async () => {
    const first = await plantCampaign();
    const ports = fakePorts();
    const [a, b] = await Promise.all([
      dispatchOtaCampaign(ports.deps, first.campaignId),
      dispatchOtaCampaign(ports.deps, first.campaignId),
    ]);
    assert.equal(a.publishedCount + b.publishedCount, 1);
    assert.equal(ports.published.length, 1, '条件 claim 阻止两个实例重复 MQTT publish');

    const stale = await plantCampaign();
    await prisma.otaTarget.updateMany({
      where: { campaignId: stale.campaignId },
      data: {
        dispatchClaimedAt: new Date(NOW.getTime() - 120_000),
        dispatchLeaseUntil: new Date(NOW.getTime() - 60_000),
        dispatchLeaseToken: 'crashed-worker',
      },
    });
    const recovered = fakePorts();
    assert.equal((await dispatchOtaCampaign(recovered.deps, stale.campaignId)).publishedCount, 1);
    assert.equal(recovered.published.length, 1);
  });

  test('claim 后暂停会撤销 grant/lease，发布前重校验阻止 MQTT', async () => {
    const { campaignId } = await plantCampaign();
    const ports = fakePorts();
    const handlers = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
    const deps: OtaPublisherDeps = {
      ...ports.deps,
      afterClaim: async () => {
        const paused = await handlers.pauseCampaign(req(operator, { params: { campaignId } }));
        assert.equal(paused.status, 200);
      },
    };
    const result = await dispatchOtaCampaign(deps, campaignId);
    assert.equal(result.publishedCount, 0);
    assert.equal(result.results[0]?.reason, 'STATE_CHANGED');
    assert.equal(ports.published.length, 0);
    const target = await prisma.otaTarget.findFirstOrThrow({ where: { campaignId } });
    assert.isNull(target.dispatchLeaseToken);
    const grant = await prisma.otaDownloadGrant.findFirstOrThrow({ where: { targetId: target.id } });
    assert.equal(grant.revokedAt?.toISOString(), NOW.toISOString());
  });

  test('target/history/通知/PUBLICATION 任一写失败时整笔事务回滚', async () => {
    const { campaignId } = await plantCampaign();
    const target = await prisma.otaTarget.findFirstOrThrow({ where: { campaignId } });
    await prisma.outboxEvent.create({
      data: {
        eventType: 'ARCHIVE',
        aggregateType: 'ota_target',
        aggregateId: target.id,
        idempotencyKey: `ota-target:${target.id}:dispatch:1:publication`,
        payload: {},
      },
    });
    const ports = fakePorts();
    let failed = false;
    try {
      await dispatchOtaCampaign(ports.deps, campaignId);
    } catch {
      // 预置幂等键触发数据库唯一约束，验证整个 finalize 事务回滚。
      failed = true;
    }
    assert.equal(failed, true, 'expected atomic finalize failure');
    const unchanged = await prisma.otaTarget.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(unchanged.status, 'PENDING');
    assert.ok(unchanged.dispatchLeaseToken, 'finalize 回滚后仍保留原 claim，等待 lease 到期恢复');
    assert.equal(await prisma.otaStatusHistory.count({ where: { targetId: target.id, toStatus: 'NOTIFIED' } }), 0);
    assert.equal(
      await prisma.outboxEvent.count({ where: { idempotencyKey: `ota-target:${target.id}:dispatch:1:available` } }),
      0,
    );
  });

  test('下载 grant 同时绑定 device/target/package/expiry/unused/revoked，且只能消费一次', async () => {
    const { campaignId, deviceId, packageId } = await plantCampaign();
    const ports = fakePorts();
    await dispatchOtaCampaign(ports.deps, campaignId);
    const payload = JSON.parse(ports.published[0]!.payload) as { data: { downloadUrl: string } };
    const url = new URL(payload.data.downloadUrl);
    const target = await prisma.otaTarget.findFirstOrThrow({ where: { campaignId, deviceId } });
    const token = url.searchParams.get('token')!;
    const signed: Array<{ key: string; expiresAt: Date }> = [];
    const deps = {
      client: prisma,
      now: () => NOW,
      objectUrlSigner: {
        signDownload(input: { key: string; expiresAt: Date }) {
          signed.push(input);
          return 'https://s3.test/short-lived-object';
        },
      },
    };
    const auth = {
      deviceId,
      certificateId: 'cert-target',
      certificateFingerprint: 'fp-target',
      customerId: null,
      siteId: null,
      deviceLifecycleStatus: 'Active',
    };
    await rejectsWithCode(
      () => redeemOtaDownloadGrant(deps, { ...auth, deviceId: 'dev-non-target' }, { targetId: target.id, token }),
      'FORBIDDEN',
    );
    const redeemed = await redeemOtaDownloadGrant(deps, auth, { targetId: target.id, token });
    assert.equal(redeemed.location, 'https://s3.test/short-lived-object');
    assert.equal(signed[0]?.key, (await prisma.firmwarePackage.findUniqueOrThrow({ where: { id: packageId } })).s3Key);
    await rejectsWithCode(() => redeemOtaDownloadGrant(deps, auth, { targetId: target.id, token }), 'CONFLICT');
  });

  test('过期或被暂停撤销的下载 grant 均失败关闭且不签发 S3 URL', async () => {
    const signerCalls: unknown[] = [];
    const objectUrlSigner = {
      signDownload(input: unknown) {
        signerCalls.push(input);
        return 'https://s3.test/must-not-be-returned';
      },
    };
    for (const mode of ['EXPIRED', 'REVOKED'] as const) {
      const { campaignId, deviceId } = await plantCampaign();
      const ports = fakePorts();
      await dispatchOtaCampaign(ports.deps, campaignId);
      const target = await prisma.otaTarget.findFirstOrThrow({ where: { campaignId } });
      const payload = JSON.parse(ports.published[0]!.payload) as { data: { downloadUrl: string } };
      const token = new URL(payload.data.downloadUrl).searchParams.get('token')!;
      if (mode === 'REVOKED') {
        const handlers = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
        await handlers.pauseCampaign(req(operator, { params: { campaignId } }));
      }
      await rejectsWithCode(
        () =>
          redeemOtaDownloadGrant(
            {
              client: prisma,
              objectUrlSigner,
              now: () => (mode === 'EXPIRED' ? new Date(NOW.getTime() + 901_000) : NOW),
            },
            {
              deviceId,
              certificateId: `cert-${mode}`,
              certificateFingerprint: `fp-${mode}`,
              customerId: null,
              siteId: null,
              deviceLifecycleStatus: 'Active',
            },
            { targetId: target.id, token },
          ),
        'CONFLICT',
      );
    }
    assert.equal(signerCalls.length, 0);
  });
});

describe('BE-OTA-03 ACK 状态接收（DEC-015 唯一通道）', () => {
  function ackOf(data: Record<string, unknown>, id = randomUUID()) {
    return { meta: { id, ts: NOW.toISOString() }, data };
  }

  test('合法状态链推进 + 每步历史 + 每步 RESULT 归档；重复上报幂等（不重复历史/归档）', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    await dispatchOtaCampaign(fakePorts().deps, campaignId);
    const target = (await prisma.otaTarget.findFirst({ where: { campaignId, deviceId } }))!;
    const deps = { client: prisma };

    for (const status of ['DOWNLOADING', 'INSTALLING', 'SUCCEEDED'] as const) {
      const res = await handleOtaAck(deps, {
        deviceId,
        ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status }),
      });
      assert.deepEqual(res, { handled: true, applied: true, replayed: false });
      assert.equal((await prisma.otaTarget.findUnique({ where: { id: target.id } }))?.status, status);
    }
    // 重复上报 SUCCEEDED → 幂等重放
    const replay = await handleOtaAck(deps, {
      deviceId,
      ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status: 'SUCCEEDED' }),
    });
    assert.deepEqual(replay, { handled: true, applied: true, replayed: true });

    const history = await prisma.otaStatusHistory.findMany({ where: { targetId: target.id } });
    assert.deepEqual(
      history.map((x) => x.toStatus).sort(),
      ['PENDING', 'NOTIFIED', 'DOWNLOADING', 'INSTALLING', 'SUCCEEDED'].sort(),
    );
    // DEC-016 RESULT 归档：3 次被接受的 ACK 各 1 条，重放不新增
    const results = (await prisma.outboxEvent.findMany({ where: { eventType: 'ARCHIVE', aggregateId: target.id } }))
      .map((e) => e.payload as Record<string, any>)
      .filter((p) => p.recordType === 'RESULT');
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.archiveClass, 'OPERATION_RECORD');
      assert.equal(r.operationType, 'ota');
      assert.equal(r.data.source, 'DEC-015_ACK_OTA_TARGET');
      assert.ok(r.data.ackId);
    }
    // 全部 SUCCEEDED → Campaign COMPLETED
    assert.equal((await prisma.otaCampaign.findUnique({ where: { id: campaignId } }))?.status, 'COMPLETED');
  });

  test('FAILED + errorCode/message 进入历史 detail；retry 后可重发并重新回报', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    await dispatchOtaCampaign(fakePorts().deps, campaignId);
    const target = (await prisma.otaTarget.findFirst({ where: { campaignId, deviceId } }))!;
    const deps = { client: prisma };

    await handleOtaAck(deps, {
      deviceId,
      ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status: 'DOWNLOADING' }),
    });
    const res = await handleOtaAck(deps, {
      deviceId,
      ack: ackOf({
        objectType: 'OTA_TARGET',
        otaTargetId: target.id,
        status: 'FAILED',
        errorCode: 'HASH_MISMATCH',
        message: 'sha mismatch',
      }),
    });
    assert.equal(res.applied, true);
    const history = await prisma.otaStatusHistory.findFirst({
      where: { targetId: target.id, toStatus: 'FAILED' },
    });
    assert.equal((history?.detail as Record<string, unknown>)?.errorCode, 'HASH_MISMATCH');

    // 管理员重试 → PENDING → 重新下发 → 重新回报 SUCCEEDED
    const h = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
    await h.retryCampaign(req(operator, { params: { campaignId }, body: {} }));
    await dispatchOtaCampaign(fakePorts().deps, campaignId);
    const back = await prisma.otaTarget.findUnique({ where: { id: target.id } });
    assert.equal(back?.status, 'NOTIFIED');
    for (const status of ['DOWNLOADING', 'INSTALLING', 'SUCCEEDED'] as const) {
      await handleOtaAck(deps, { deviceId, ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status }) });
    }
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: target.id } }))?.status, 'SUCCEEDED');
  });

  test('通道隔离与防御：COMMAND 移交；混带 COMMAND 字段/缺关联键/未知状态/未知 target → 拒绝且无副作用', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    await dispatchOtaCampaign(fakePorts().deps, campaignId);
    const target = (await prisma.otaTarget.findFirst({ where: { campaignId, deviceId } }))!;
    const deps = { client: prisma };

    // objectType=COMMAND → 移交 BE-CMD-03
    assert.deepEqual(
      await handleOtaAck(deps, { deviceId, ack: ackOf({ objectType: 'COMMAND', commandId: 'c1', result: 'SUCCESS' }) }),
      { handled: false, applied: false },
    );
    // DEC-015：COMMAND 字段混带 → 拒绝
    for (const mixed of [{ commandId: 'c1' }, { command: 'START' }, { result: 'SUCCESS' }, { executeTimeMs: 1 }]) {
      const res = await handleOtaAck(deps, {
        deviceId,
        ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status: 'DOWNLOADING', ...mixed }),
      });
      assert.deepEqual(res, { handled: true, applied: false, reason: 'MIXED_FIELDS' }, JSON.stringify(mixed));
    }
    // 缺 otaTargetId / 未知状态
    assert.equal(
      (await handleOtaAck(deps, { deviceId, ack: ackOf({ objectType: 'OTA_TARGET', status: 'DOWNLOADING' }) })).reason,
      'INVALID_ACK',
    );
    assert.equal(
      (
        await handleOtaAck(deps, {
          deviceId,
          ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status: 'BRICKED' }),
        })
      ).reason,
      'INVALID_ACK',
    );
    // 未知 target
    assert.equal(
      (
        await handleOtaAck(deps, {
          deviceId,
          ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: 't-unknown', status: 'DOWNLOADING' }),
        })
      ).reason,
      'TARGET_NOT_FOUND',
    );
    // 非目标设备回报（设备绑定）→ 拒绝且状态不变
    const wrong = await handleOtaAck(deps, {
      deviceId: 'dev-other',
      ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status: 'DOWNLOADING' }),
    });
    assert.equal(wrong.reason, 'DEVICE_MISMATCH');
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: target.id } }))?.status, 'NOTIFIED');
    // 非法迁移（NOTIFIED → SUCCEEDED 跳阶段）
    const illegal = await handleOtaAck(deps, {
      deviceId,
      ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status: 'SUCCEEDED' }),
    });
    assert.equal(illegal.reason, 'ILLEGAL_TRANSITION');
    // 迟到 ACK：target 取消后回报 → 不产生状态变化
    const h = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
    await h.cancelCampaign(req(operator, { params: { campaignId } }));
    const late = await handleOtaAck(deps, {
      deviceId,
      ack: ackOf({ objectType: 'OTA_TARGET', otaTargetId: target.id, status: 'DOWNLOADING' }),
    });
    assert.equal(late.reason, 'TARGET_TERMINAL');
    assert.equal((await prisma.otaTarget.findUnique({ where: { id: target.id } }))?.status, 'CANCELLED');
    // 全程无 RESULT 归档（均未被接受）
    const archives = (await prisma.outboxEvent.findMany({ where: { eventType: 'ARCHIVE', aggregateId: target.id } }))
      .map((e) => e.payload as Record<string, any>)
      .filter((p) => p.recordType === 'RESULT');
    assert.equal(archives.length, 0);
  });

  test('取消后设备获得正确 Notification：已通知设备收 OTA_CANCELLED；PENDING 设备不发', async () => {
    const { campaignId, deviceId } = await plantCampaign();
    // 只下发首批（extra 扩展在后，保持 PENDING 未通知）
    await dispatchOtaCampaign(fakePorts().deps, campaignId);
    const t1 = (await prisma.otaTarget.findFirst({ where: { campaignId, deviceId } }))!;
    assert.equal(t1.status, 'NOTIFIED');
    const extra = await plantDevice();
    await expandWith(campaignId, extra);

    const h = createAdminOtaCampaignHandlers({ client: prisma, now: () => NOW });
    await h.cancelCampaign(req(operator, { params: { campaignId } }));

    const t2 = (await prisma.otaTarget.findFirst({ where: { campaignId, deviceId: extra } }))!;
    const cancelled = await prisma.outboxEvent.findMany({
      where: { eventType: 'OTA_CANCELLED', aggregateId: { in: [t1.id, t2.id] } },
    });
    assert.equal(cancelled.length, 1, '仅已通知设备收到取消通知');
    const p = cancelled[0]?.payload as Record<string, any>;
    assert.equal(p.topic, `bnx/device/${deviceId}/notification`);
    assert.deepEqual(p.data, { type: 'OTA_CANCELLED', action: 'CANCEL_PENDING_OTA' });
    assert.equal(p.otaTargetId, t1.id);
  });

  test('不存在第二条未登记回传通道：topic-catalog 中 ota 仅下行，无 ota 上行/status Topic', () => {
    const topics = topicCatalog.topics as { type: string; direction: string }[];
    const otaTopics = topics.filter((t) => t.type.includes('ota'));
    assert.deepEqual(
      otaTopics.map((t) => `${t.type}:${t.direction}`),
      ['ota:downlink'],
    );
    const ack = topics.find((t) => t.type === 'ack');
    assert.equal(ack?.direction, 'uplink', 'ACK 为 DEC-015 唯一上行回传通道');
  });
});

async function assertRejectsNotFound(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    assert.equal((err as Error).name, 'AdminOtaCampaignError');
    return;
  }
  assert.fail('expected rejection');
}
