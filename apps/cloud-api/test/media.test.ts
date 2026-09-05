/**
 * BE-MED-01 Media 上传会话与元数据 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 跨设备 Key / 任意 Bucket-Key 拒绝（objectPath 必须逐字符等于已签发会话 Key）；
 * - 超限文件拒绝（sizeKb 超类型上限 / 每设备每日配额超限 409）；
 * - 不存在 Object 拒绝（OBJECT_MISSING）；Hash 不符拒绝（HASH_MISMATCH）；大小不符拒绝；
 * - 申报一致性（fileName/mediaType/sizeKb 与会话不一致拒绝）；幂等（sourceMessageId 重放）；
 * - 下载遵守 Customer 权限（跨 Customer → 404；DELETED 不提供下载；URL 15 分钟过期）；
 * - 设备认证：无证书/未知证书 → 401；Suspended/Retired/未分配 Customer → 403；
 * - 审计：media.upload_session.create / media.object.register。
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { certificateFingerprintFromPem } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import {
  buildMediaObjectKey,
  createAdminMediaHandlers,
  createDeviceMediaHandler,
  handleMediaMetadata,
} from '../src/index.js';
import type { AdminHttpRequest, MediaDeps, MediaUploadPolicyQuery } from '../src/index.js';
import { createTestDb } from './helpers.js';

/** 策略门面：取值与 contracts/media/media-upload-policy.json 暂定值一致（该一致性由 contracts 侧测试强制）。 */
const realPolicy: MediaUploadPolicyQuery = {
  getMediaTypes: () => ['IMAGE', 'VIDEO'],
  getMaxSizeKb: (t) => ({ IMAGE: 10240, VIDEO: 204800 })[t as 'IMAGE' | 'VIDEO'],
  getDailyUploadQuotaPerDevice: () => 100,
  getUploadUrlTtlSeconds: () => 900,
  getDownloadUrlTtlSeconds: () => 900,
};

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-05T08:00:00Z');

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
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

function fixturePem(seed: string): string {
  const body = Buffer.from(`media-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

interface PlantedDevice {
  deviceId: string;
  pem: string;
  customerId: string | null;
}

async function plantDevice(options: { lifecycleStatus?: string; withCustomer?: boolean } = {}): Promise<PlantedDevice> {
  seq += 1;
  let customerId: string | null = null;
  if (options.withCustomer !== false) {
    const customer = await prisma.customer.create({ data: { name: `MED ${seq}` } });
    customerId = customer.id;
  }
  const deviceId = `dev-med-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-MED-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      customerId,
    },
  });
  const pem = fixturePem(`${seq}`);
  await prisma.deviceCertificate.create({
    data: {
      id: `cert-med-${seq}`,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      certificatePem: pem,
      packageCiphertext: Buffer.from('media-secret-package'),
      notBefore: new Date(NOW.getTime() - 30 * 86_400_000),
      notAfter: new Date(NOW.getTime() + 200 * 86_400_000),
    },
  });
  return { deviceId, pem, customerId };
}

function fakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    storage: {
      async statObject(key: string) {
        const body = objects.get(key);
        return body ? { sizeBytes: body.length } : null;
      },
      async computeSha256(key: string) {
        const body = objects.get(key);
        return body ? createHash('sha256').update(body).digest('hex') : null;
      },
    },
  };
}

function mediaDeps(store: ReturnType<typeof fakeStorage>, policy: MediaUploadPolicyQuery = realPolicy): MediaDeps {
  return {
    client: prisma,
    now: () => NOW,
    storage: store.storage,
    urlSigner: {
      signUpload: ({ key, expiresAt }) =>
        `https://upload.test/${key}?expires=${encodeURIComponent(expiresAt.toISOString())}`,
      signDownload: ({ key, expiresAt }) =>
        `https://download.test/${key}?expires=${encodeURIComponent(expiresAt.toISOString())}`,
    },
    uploadPolicy: policy,
  };
}

type DataBody = { data: any; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type ErrBody = { error: { code: string; message: string } };

/** 创建会话（设备端 handler），返回 201 视图。 */
async function createSession(
  store: ReturnType<typeof fakeStorage>,
  device: PlantedDevice,
  content: Buffer,
  overrides: Record<string, unknown> = {},
  policy?: MediaUploadPolicyQuery,
) {
  const handler = createDeviceMediaHandler(mediaDeps(store, policy));
  const body = {
    mediaType: 'IMAGE',
    fileName: 'snap.jpg',
    sizeKb: Math.ceil(content.length / 1024),
    sha256: createHash('sha256').update(content).digest('hex'),
    ...overrides,
  };
  return handler({ identity: { clientCertPem: device.pem }, body, requestId: `req-${seq}-${Math.random()}` });
}

interface SessionView {
  sessionId: string;
  objectPath: string;
  fileName: string;
  mediaType: string;
  sizeKb: number;
}

function metadataMessage(
  session: Pick<SessionView, 'objectPath' | 'fileName' | 'mediaType' | 'sizeKb'>,
  messageId?: string,
) {
  return {
    meta: { id: messageId ?? `MED-MSG-${++seq}`, ts: NOW.toISOString() },
    data: {
      mediaType: session.mediaType,
      captureTime: NOW.toISOString(),
      fileName: session.fileName,
      objectPath: session.objectPath,
      sizeKb: session.sizeKb,
      durationSec: 0,
    },
  };
}

describe('BE-MED-01 设备上传会话', () => {
  test('认证与生命周期：无证书/未知证书 → 401；Suspended/Retired/未分配 Customer → 403', async () => {
    const store = fakeStorage();
    const device = await plantDevice();
    const content = Buffer.alloc(2048, 1);
    // 无证书
    assert.equal((await createSession(store, { ...device, pem: '' }, content)).status, 401);
    // 未知证书
    assert.equal((await createSession(store, { ...device, pem: fixturePem('ghost') }, content)).status, 401);
    // Suspended
    const suspended = await plantDevice({ lifecycleStatus: 'Suspended' });
    const r1 = await createSession(store, suspended, content);
    assert.equal(r1.status, 403);
    assert.equal((r1.body as ErrBody).error.code, 'FORBIDDEN');
    // Retired（AUTH-03 先行拒绝）
    const retired = await plantDevice({ lifecycleStatus: 'Retired' });
    assert.equal((await createSession(store, retired, content)).status, 403);
    // 未分配 Customer
    const unassigned = await plantDevice({ withCustomer: false });
    assert.equal((await createSession(store, unassigned, content)).status, 403);
    // Maintenance 放行
    const maintenance = await plantDevice({ lifecycleStatus: 'Maintenance' });
    assert.equal((await createSession(store, maintenance, content)).status, 201);
  });

  test('字段校验：非法 mediaType/fileName/超限 sizeKb/非法 sha256 → 400', async () => {
    const store = fakeStorage();
    const device = await plantDevice();
    const content = Buffer.alloc(2048, 1);
    const cases: Record<string, unknown>[] = [
      { mediaType: 'AUDIO' },
      { fileName: '../escape.jpg' },
      { fileName: 'a/b.jpg' },
      { fileName: '' },
      { sizeKb: 0 },
      { sizeKb: 1.5 },
      { sizeKb: 10241 }, // IMAGE 上限 10240（策略暂定值）
      { mediaType: 'VIDEO', sizeKb: 204801 }, // VIDEO 上限 204800
      { sha256: 'abc' },
    ];
    for (const bad of cases) {
      const res = await createSession(store, device, content, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
  });

  test('成功：201 + 设备前缀 objectPath + 15 分钟上传 URL + 申报 Hash 落库 + 审计', async () => {
    const store = fakeStorage();
    const device = await plantDevice();
    const content = Buffer.alloc(2048, 2);
    const res = await createSession(store, device, content);
    assert.equal(res.status, 201);
    const view = (res.body as DataBody).data;
    assert.equal(
      view.objectPath,
      buildMediaObjectKey({
        customerId: device.customerId!,
        deviceId: device.deviceId,
        sessionId: view.sessionId,
        fileName: 'snap.jpg',
      }),
    );
    assert.ok(view.uploadUrl.startsWith('https://'));
    assert.ok(view.uploadUrl.includes(view.objectPath));
    assert.equal(new Date(view.uploadUrlExpiresAt).getTime() - NOW.getTime(), 900 * 1000);

    const row = await prisma.mediaUploadSession.findUnique({ where: { id: view.sessionId } });
    assert.equal(row?.status, 'ISSUED');
    assert.equal(row?.declaredSha256, createHash('sha256').update(content).digest('hex'));

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'media_upload_session', objectId: view.sessionId, action: 'media.upload_session.create' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
  });

  test('配额：每设备每日上传会话超限 → 409', async () => {
    const store = fakeStorage();
    const device = await plantDevice();
    const policy2: MediaUploadPolicyQuery = { ...realPolicy, getDailyUploadQuotaPerDevice: () => 2 };
    const content = Buffer.alloc(1024, 3);
    assert.equal((await createSession(store, device, content, {}, policy2)).status, 201);
    assert.equal((await createSession(store, device, content, { fileName: 'b.jpg' }, policy2)).status, 201);
    const third = await createSession(store, device, content, { fileName: 'c.jpg' }, policy2);
    assert.equal(third.status, 409);
    assert.equal((third.body as ErrBody).error.code, 'CONFLICT');
  });
});

describe('BE-MED-01 元数据校验（Media Handler）', () => {
  test('成功：Object/大小/Hash 匹配 → MediaObject AVAILABLE + 会话 COMPLETED + 审计；重放幂等', async () => {
    const store = fakeStorage();
    const device = await plantDevice();
    const content = Buffer.alloc(2048, 4);
    const res = await createSession(store, device, content);
    const session = (res.body as DataBody).data;
    store.objects.set(session.objectPath, content);

    const msg = metadataMessage(session);
    const result = await handleMediaMetadata(mediaDeps(store), device.deviceId, msg);
    assert.equal(result.applied, true);
    assert.equal(result.replayed, false);
    assert.ok(result.mediaId);

    const media = await prisma.mediaObject.findUnique({ where: { id: result.mediaId } });
    assert.equal(media?.status, 'AVAILABLE');
    assert.equal(media?.deviceId, device.deviceId);
    assert.equal(media?.customerId, device.customerId);
    assert.equal(media?.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(media?.sourceMessageId, msg.meta.id);
    assert.equal(
      (await prisma.mediaUploadSession.findUnique({ where: { id: session.sessionId } }))?.status,
      'COMPLETED',
    );

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'media_object', objectId: result.mediaId, action: 'media.object.register' },
    });
    assert.equal(audits.length, 1);

    // 重复上报（同 meta.id）→ 幂等回放，无新写入
    const replay = await handleMediaMetadata(mediaDeps(store), device.deviceId, msg);
    assert.deepEqual(replay, { applied: true, replayed: true, mediaId: result.mediaId });
    assert.equal(await prisma.mediaObject.count({ where: { uploadSessionId: session.sessionId } }), 1);
  });

  test('跨设备 Key / 任意 Key / 未知会话拒绝且无写入', async () => {
    const store = fakeStorage();
    const deviceA = await plantDevice();
    const deviceB = await plantDevice();
    const content = Buffer.alloc(2048, 5);
    const res = await createSession(store, deviceA, content);
    const session = (res.body as DataBody).data;
    store.objects.set(session.objectPath, content);
    const deps = mediaDeps(store);
    const before = await prisma.mediaObject.count();

    // 设备 B 冒用设备 A 的 objectPath（跨设备 Key）
    const cross = await handleMediaMetadata(deps, deviceB.deviceId, metadataMessage(session));
    assert.deepEqual(cross, { applied: false, reason: 'FORBIDDEN_PATH' });
    // 任意 Key（他人前缀）→ FORBIDDEN_PATH
    const arbitrary = await handleMediaMetadata(
      deps,
      deviceA.deviceId,
      metadataMessage({ ...session, objectPath: 'media/other/other/x/x.jpg' }),
    );
    assert.deepEqual(arbitrary, { applied: false, reason: 'FORBIDDEN_PATH' });
    // 本设备前缀但未签发的会话 → UNKNOWN_SESSION
    const unknown = await handleMediaMetadata(
      deps,
      deviceA.deviceId,
      metadataMessage({
        ...session,
        objectPath: `media/${deviceA.customerId}/${deviceA.deviceId}/session-unknown/x.jpg`,
      }),
    );
    assert.deepEqual(unknown, { applied: false, reason: 'UNKNOWN_SESSION' });
    // 非模板 Key
    const outside = await handleMediaMetadata(
      deps,
      deviceA.deviceId,
      metadataMessage({ ...session, objectPath: 's3://bucket/anywhere.jpg' }),
    );
    assert.deepEqual(outside, { applied: false, reason: 'FORBIDDEN_PATH' });

    assert.equal(await prisma.mediaObject.count(), before);
    assert.equal((await prisma.mediaUploadSession.findUnique({ where: { id: session.sessionId } }))?.status, 'ISSUED');
  });

  test('不存在 Object / 大小不符 / Hash 不符 / 申报不一致均拒绝', async () => {
    const store = fakeStorage();
    const device = await plantDevice();
    const deps = mediaDeps(store);
    const content = Buffer.alloc(2048, 6);

    // Object 缺失
    const s1 = (await createSession(store, device, content, { fileName: 'm1.jpg' })).body as DataBody;
    assert.deepEqual(await handleMediaMetadata(deps, device.deviceId, metadataMessage(s1.data as never)), {
      applied: false,
      reason: 'OBJECT_MISSING',
    });

    // 大小不符（实际内容与申报 sizeKb 不一致）
    const s2Res = await createSession(store, device, content, { fileName: 'm2.jpg' });
    const s2 = (s2Res.body as DataBody).data;
    store.objects.set(s2.objectPath, Buffer.alloc(1024, 6));
    assert.equal(
      (await handleMediaMetadata(deps, device.deviceId, metadataMessage(s2 as never))).reason,
      'SIZE_MISMATCH',
    );

    // Hash 不符（声明的 sha 对应 content，实际对象不同内容但同大小）
    const s3Res = await createSession(store, device, content, { fileName: 'm3.jpg' });
    const s3 = (s3Res.body as DataBody).data;
    store.objects.set(s3.objectPath, Buffer.alloc(2048, 7));
    assert.equal(
      (await handleMediaMetadata(deps, device.deviceId, metadataMessage(s3 as never))).reason,
      'HASH_MISMATCH',
    );

    // 申报不一致（fileName/mediaType/sizeKb 与会话不符）
    const s4Res = await createSession(store, device, content, { fileName: 'm4.jpg' });
    const s4 = (s4Res.body as DataBody).data;
    store.objects.set(s4.objectPath, content);
    const renamed = metadataMessage(s4 as never);
    renamed.data.fileName = 'other.jpg';
    assert.equal((await handleMediaMetadata(deps, device.deviceId, renamed)).reason, 'METADATA_MISMATCH');
    const wrongType = metadataMessage(s4 as never);
    wrongType.data.mediaType = 'VIDEO';
    assert.equal((await handleMediaMetadata(deps, device.deviceId, wrongType)).reason, 'METADATA_MISMATCH');
    const wrongSize = metadataMessage(s4 as never);
    wrongSize.data.sizeKb = 1;
    assert.equal((await handleMediaMetadata(deps, device.deviceId, wrongSize)).reason, 'METADATA_MISMATCH');

    // 全部拒绝后无 MediaObject 写入
    assert.equal(await prisma.mediaObject.count({ where: { deviceId: device.deviceId } }), 0);
  });

  test('非法报文字段 / 未知设备拒绝', async () => {
    const store = fakeStorage();
    const device = await plantDevice();
    const deps = mediaDeps(store);
    const base = metadataMessage({ objectPath: 'media/c/d/s/f.jpg', fileName: 'f.jpg', mediaType: 'IMAGE', sizeKb: 2 });
    assert.equal(
      (await handleMediaMetadata(deps, device.deviceId, { ...base, data: { ...base.data, mediaType: 'AUDIO' } }))
        .reason,
      'INVALID_MESSAGE',
    );
    assert.equal(
      (await handleMediaMetadata(deps, device.deviceId, { ...base, data: { ...base.data, captureTime: 'not-a-date' } }))
        .reason,
      'INVALID_MESSAGE',
    );
    assert.equal(
      (await handleMediaMetadata(deps, device.deviceId, { ...base, meta: { id: '', ts: NOW.toISOString() } })).reason,
      'INVALID_MESSAGE',
    );
    assert.equal((await handleMediaMetadata(deps, 'dev-ghost', base)).reason, 'DEVICE_NOT_FOUND');
  });
});

describe('BE-MED-01 管理端列表与下载', () => {
  async function plantMedia(device: PlantedDevice, store: ReturnType<typeof fakeStorage>, fileName = 'snap.jpg') {
    const content = Buffer.from(`media-${fileName}-${Math.random()}`);
    const res = await createSession(store, device, content, { fileName });
    const session = (res.body as DataBody).data;
    store.objects.set(session.objectPath, content);
    const result = await handleMediaMetadata(mediaDeps(store), device.deviceId, metadataMessage(session));
    assert.equal(result.applied, true);
    return result.mediaId as string;
  }

  test('列表：筛选/分页/租户隔离；下载：15 分钟 URL；跨 Customer → 404；DELETED → 404；无 actor → 401', async () => {
    const store = fakeStorage();
    const deviceA = await plantDevice();
    const deviceB = await plantDevice(); // 不同 Customer
    const m1 = await plantMedia(deviceA, store, 'a.jpg');
    const m2 = await plantMedia(deviceA, store, 'b.jpg');
    await plantMedia(deviceB, store, 'c.jpg');
    const deps = mediaDeps(store);
    const h = createAdminMediaHandlers(deps);
    const req = (actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest => ({
      actor,
      headers: {},
      requestId: `req-${Math.random()}`,
      ...options,
    });

    // 无 actor → 401
    assert.equal((await h.listMedia(req(undefined, { query: {} }))).status, 401);

    // 平台角色全量 + 筛选
    const all = await h.listMedia(req(superAdmin, { query: {} }));
    assert.ok((all.body as ListBody).data.length >= 3);
    const byDevice = await h.listMedia(req(superAdmin, { query: { deviceId: deviceA.deviceId } }));
    assert.equal((byDevice.body as ListBody).data.length, 2);
    const byType = await h.listMedia(req(superAdmin, { query: { mediaType: 'VIDEO' } }));
    assert.equal((byType.body as ListBody).data.filter((m) => [m1, m2].includes(m.mediaId)).length, 0);
    // 视图不泄露 objectPath
    assert.ok(!('objectPath' in (all.body as ListBody).data[0]!));
    // 非法筛选 → 400
    assert.equal((await h.listMedia(req(superAdmin, { query: { mediaType: 'AUDIO' } }))).status, 400);
    assert.equal((await h.listMedia(req(superAdmin, { query: { from: 'not-a-date' } }))).status, 400);
    // 分页
    const page1 = await h.listMedia(req(superAdmin, { query: { deviceId: deviceA.deviceId, limit: '1' } }));
    assert.equal((page1.body as ListBody).data.length, 1);
    assert.ok((page1.body as ListBody).meta.nextCursor);
    const page2 = await h.listMedia(
      req(superAdmin, {
        query: { deviceId: deviceA.deviceId, limit: '1', cursor: (page1.body as ListBody).meta.nextCursor },
      }),
    );
    assert.equal((page2.body as ListBody).data.length, 1);

    // Customer 角色租户隔离
    const custA: ActorContext = {
      actorId: 'ca-a',
      username: 'ca-a',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: deviceA.customerId,
      tokenUse: 'access',
    };
    const scoped = await h.listMedia(req(custA, { query: {} }));
    assert.ok((scoped.body as ListBody).data.every((m) => m.customerId === deviceA.customerId));
    assert.equal((await h.listMedia(req(custA, { query: { customerId: deviceB.customerId! } }))).status, 403);

    // 下载 URL：15 分钟 + 本 Customer 可用
    const dl = await h.createDownloadUrl(req(custA, { params: { mediaId: m1 } }));
    assert.equal(dl.status, 200);
    const dlData = (dl.body as DataBody).data;
    assert.ok(dlData.downloadUrl.startsWith('https://'));
    assert.equal(new Date(dlData.downloadUrlExpiresAt).getTime() - NOW.getTime(), 900 * 1000);

    // 跨 Customer 下载 → 404
    const custB: ActorContext = { ...custA, actorId: 'ca-b', customerId: deviceB.customerId };
    assert.equal((await h.createDownloadUrl(req(custB, { params: { mediaId: m1 } }))).status, 404);
    // 不存在 → 404
    assert.equal((await h.createDownloadUrl(req(superAdmin, { params: { mediaId: 'm-unknown' } }))).status, 404);
    // DELETED（文件到期删除，元数据保留）→ 404
    await prisma.mediaObject.update({ where: { id: m2 }, data: { status: 'DELETED' } });
    assert.equal((await h.createDownloadUrl(req(superAdmin, { params: { mediaId: m2 } }))).status, 404);
    // DELETED 仍在列表（元数据保留）
    const deletedList = await h.listMedia(req(superAdmin, { query: { status: 'DELETED' } }));
    assert.ok((deletedList.body as ListBody).data.some((m) => m.mediaId === m2));
  });
});
