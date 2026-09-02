/**
 * BE-OTA-01 Firmware Package API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - Hash/签名/型号不匹配拒绝（大小/SHA-256 重算/数字签名全部负向路径，拒绝后保持 UPLOADED）；
 * - 成功包不可覆盖（VERIFIED 重复完成 → 409；同型号+版本+packageType/同 sha256 重复创建 → 409）；
 * - 未完成上传不进入可发布列表（可发布 = status VERIFIED；UPLOADED 不出现在 VERIFIED 列表）；
 * - 签名格式由项目冻结值驱动（provisional 策略失败关闭 → 409；verifier/策略算法错配 → 409）；
 * - 鉴权：无 actor → 401；无 ota:write/ota:read → 403（Customer 角色无 OTA 权限）；
 * - 短期预签名 URL（900s 暂定）；objectKey 服务端生成；审计 ota.package.upload_session.create /
 *   ota.package.verify；错误响应不泄露 AWS 内部信息。
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  ADMIN_OTA_PACKAGE_ERROR_HTTP_STATUS,
  MAX_FIRMWARE_PACKAGE_SIZE_BYTES,
  OTA_UPLOAD_URL_TTL_SECONDS,
  buildSignaturePayload,
  createAdminOtaPackageHandlers,
} from '../src/index.js';
import type {
  AdminHttpRequest,
  AdminOtaPackageHandlerDeps,
  FirmwareUploadSessionView,
  OtaSignaturePolicyQuery,
} from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-02T08:00:00Z');
const PAYLOAD_FIELDS = ['model', 'version', 'packageType', 'sha256'];

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

// ---------- 注入端口夹具 ----------

/** 模拟 provisional 策略：参数读取失败关闭（语义同 PolicyParameterPendingError）。 */
class PolicyParameterPendingError extends Error {
  override readonly name = 'PolicyParameterPendingError';
  constructor(readonly parameter: string) {
    super(`POLICY_PARAMETER_PENDING: ${parameter}`);
  }
}

const frozenPolicy: OtaSignaturePolicyQuery = {
  getSignatureAlgorithm: () => 'Ed25519',
  getSignatureTrustRoot: () => 'test-trust-root',
  getSignatureEncoding: () => 'hex',
  getSignaturePayloadFields: () => PAYLOAD_FIELDS,
};

const pendingPolicy: OtaSignaturePolicyQuery = {
  ...frozenPolicy,
  getSignatureAlgorithm: () => {
    throw new PolicyParameterPendingError('signature.algorithm');
  },
};

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

function fakeUrlSigner() {
  return {
    signUpload(input: { key: string; expiresAt: Date }) {
      return `https://ota.test/${input.key}?expires=${input.expiresAt.toISOString()}`;
    },
  };
}

/** 测试 verifier：约定签名 = `sig:${payload}` 为有效。 */
function fakeVerifier(algorithmId = 'Ed25519') {
  return {
    algorithmId,
    verify(input: { payload: string; signature: string }) {
      return input.signature === `sig:${input.payload}`;
    },
  };
}

function validSignature(input: { model: string; version: string; packageType: string; sha256: string }): string {
  return `sig:${buildSignaturePayload(PAYLOAD_FIELDS, { ...input, sha256: input.sha256.toLowerCase() })}`;
}

function handlers(options: {
  at?: Date;
  policy?: OtaSignaturePolicyQuery;
  verifierAlgorithm?: string;
  malwareScanner?: AdminOtaPackageHandlerDeps['malwareScanner'];
  storage?: ReturnType<typeof fakeStorage>['storage'];
}) {
  const store = fakeStorage();
  const deps: AdminOtaPackageHandlerDeps = {
    client: prisma,
    now: () => options.at ?? NOW,
    storage: options.storage ?? store.storage,
    uploadUrlSigner: fakeUrlSigner(),
    signaturePolicy: options.policy ?? frozenPolicy,
    signatureVerifier: fakeVerifier(options.verifierAlgorithm),
    ...(options.malwareScanner !== undefined ? { malwareScanner: options.malwareScanner } : {}),
  };
  return { h: createAdminOtaPackageHandlers(deps), deps, store };
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

type DataBody = { data: Record<string, any>; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type ErrBody = { error: { code: string; message: string; requestId: string } };

let seq = 0;

/** 生成一包内容并派生合法声明（sha256/签名均真实可验）。 */
function makePackageFixture(model?: string) {
  seq += 1;
  const content = Buffer.from(`firmware-image-${seq}-${Math.random()}`);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const declared = {
    model: model ?? `BNX-${100 + seq}`,
    version: `1.0.${seq}`,
    packageType: 'FIRMWARE',
    sizeBytes: content.length,
    sha256,
  };
  return { content, declared, body: { ...declared, signature: validSignature(declared) } };
}

async function createSession(
  h: ReturnType<typeof handlers>['h'],
  body: Record<string, unknown>,
  actor: ActorContext = operator,
) {
  return h.createUploadSession(req(actor, { body }));
}

/** 创建会话并上传真实内容（对象落入 fake storage）。 */
async function createAndUpload(
  h: ReturnType<typeof handlers>['h'],
  store: ReturnType<typeof fakeStorage>,
  model?: string,
): Promise<{ session: FirmwareUploadSessionView; fixture: ReturnType<typeof makePackageFixture> }> {
  const fixture = makePackageFixture(model);
  const res = await createSession(h, fixture.body);
  assert.equal(res.status, 201);
  const session = (res.body as DataBody).data as unknown as FirmwareUploadSessionView;
  store.objects.set(session.objectKey, fixture.content);
  return { session, fixture };
}

describe('BE-OTA-01 创建上传会话', () => {
  test('鉴权：无 actor → 401；CustomerAdmin/Auditor 无 ota:write → 403；Operator/SuperAdmin 放行', async () => {
    const { h } = handlers({});
    const fixture = makePackageFixture();

    const unauthenticated = await h.createUploadSession(req(undefined, { body: fixture.body }));
    assert.equal(unauthenticated.status, 401);
    assert.equal((unauthenticated.body as ErrBody).error.code, 'UNAUTHENTICATED');

    for (const actor of [customerAdmin, auditor]) {
      const res = await createSession(h, fixture.body, actor);
      assert.equal(res.status, 403);
      assert.equal((res.body as ErrBody).error.code, 'FORBIDDEN');
    }

    assert.equal((await createSession(h, fixture.body, operator)).status, 201);
    const dup = makePackageFixture();
    assert.equal((await createSession(h, dup.body, superAdmin)).status, 201);
  });

  test('字段校验：缺字段/非法 packageType/非法 sha256/越界 sizeBytes/路径字符 model → 400', async () => {
    const { h } = handlers({});
    const { body } = makePackageFixture();
    const cases: Record<string, unknown>[] = [
      { ...body, model: '' },
      { ...body, model: '../escape' },
      { ...body, version: 'a/b' },
      { ...body, packageType: 'OS' },
      { ...body, sha256: 'abc' },
      { ...body, sha256: body.sha256.toUpperCase().replace(/[A-F]/g, 'G') },
      { ...body, sizeBytes: 0 },
      { ...body, sizeBytes: -1 },
      { ...body, sizeBytes: MAX_FIRMWARE_PACKAGE_SIZE_BYTES + 1 },
      { ...body, sizeBytes: 1.5 },
      { ...body, signature: '' },
      (({ signature: _s, ...rest }) => rest)(body),
    ];
    for (const bad of cases) {
      const res = await createSession(h, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    // 大写 hex sha256 合法（归一化小写存储）
    const upper = makePackageFixture();
    const ok = await createSession(h, { ...upper.body, sha256: upper.body.sha256.toUpperCase() });
    assert.equal(ok.status, 201);
    assert.equal((ok.body as DataBody).data.sha256, upper.body.sha256);
  });

  test('成功：201 UPLOADED + 服务端 objectKey + 短期预签名 URL（900s）+ uploadedBy 取身份上下文 + 审计', async () => {
    const { h } = handlers({});
    const fixture = makePackageFixture();
    const res = await createSession(h, fixture.body, operator);
    assert.equal(res.status, 201);
    const view = (res.body as DataBody).data;
    assert.equal(view.status, 'UPLOADED');
    assert.ok(view.packageId);
    // objectKey 服务端生成：前缀固定 + 含 packageId，客户端不可指定
    assert.match(
      view.objectKey,
      new RegExp(`^firmware-packages/${fixture.declared.model}/FIRMWARE/${fixture.declared.version}/`),
    );
    assert.ok(view.objectKey.endsWith(view.packageId));
    // 短期预签名 URL：https + 900s 过期
    assert.ok(view.uploadUrl.startsWith('https://'));
    assert.ok(view.uploadUrl.includes(view.objectKey));
    assert.equal(new Date(view.uploadUrlExpiresAt).getTime() - NOW.getTime(), OTA_UPLOAD_URL_TTL_SECONDS * 1000);

    const row = await prisma.firmwarePackage.findUnique({ where: { id: view.packageId } });
    assert.equal(row?.status, 'UPLOADED');
    assert.equal(row?.uploadedBy, operator.actorId);
    assert.equal(row?.signature, fixture.body.signature);

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'firmware_package', objectId: view.packageId, action: 'ota.package.upload_session.create' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, operator.actorId);
  });

  test('同型号+版本+packageType 重复 → 409；同 sha256 不同型号 → 409（成功包不可覆盖）', async () => {
    const { h } = handlers({});
    const fixture = makePackageFixture();
    assert.equal((await createSession(h, fixture.body)).status, 201);

    // 同型号+版本+packageType（内容不同也一样拒绝）
    const sameIdentity = {
      ...makePackageFixture().body,
      ...fixture.declared,
      sha256: createHash('sha256').update('other').digest('hex'),
    };
    const dup = await createSession(h, sameIdentity);
    assert.equal(dup.status, 409);
    assert.equal((dup.body as ErrBody).error.code, 'CONFLICT');

    // 同 sha256（不同型号/版本）→ 唯一约束拒绝
    const sameHash = { ...makePackageFixture().body, sha256: fixture.declared.sha256 };
    const dupHash = await createSession(h, sameHash);
    assert.equal(dupHash.status, 409);
  });
});

describe('BE-OTA-01 上传完成校验（complete）', () => {
  test('对象不存在（未完成上传）→ 400，保持 UPLOADED，不进入可发布列表', async () => {
    const { h } = handlers({});
    const fixture = makePackageFixture();
    const res = await createSession(h, fixture.body);
    const session = (res.body as DataBody).data;

    const complete = await h.completeUpload(req(operator, { params: { packageId: session.packageId } }));
    assert.equal(complete.status, 400);
    assert.equal((complete.body as ErrBody).error.code, 'VALIDATION_FAILED');

    const row = await prisma.firmwarePackage.findUnique({ where: { id: session.packageId } });
    assert.equal(row?.status, 'UPLOADED');
    const publishable = await h.listPackages(req(auditor, { query: { status: 'VERIFIED' } }));
    assert.ok(!(publishable.body as ListBody).data.some((p) => p.packageId === session.packageId));
  });

  test('大小不匹配 → 400；SHA-256 不匹配 → 400；签名不匹配（含型号错配）→ 400', async () => {
    const { h, store } = handlers({});

    // 大小不匹配：声明 sizeBytes 与实际对象不同
    const sizeFixture = makePackageFixture();
    const s1 = await createSession(h, { ...sizeFixture.body, sizeBytes: sizeFixture.content.length + 1 });
    assert.equal(s1.status, 201);
    const s1Data = (s1.body as DataBody).data;
    store.objects.set(s1Data.objectKey, sizeFixture.content);
    const sizeRes = await h.completeUpload(req(operator, { params: { packageId: s1Data.packageId } }));
    assert.equal(sizeRes.status, 400);
    assert.equal((sizeRes.body as ErrBody).error.code, 'VALIDATION_FAILED');

    // Hash 不匹配：声明 sha256 属于另一内容
    const hashFixture = makePackageFixture();
    const s2 = await createSession(h, hashFixture.body);
    const s2Data = (s2.body as DataBody).data;
    store.objects.set(s2Data.objectKey, Buffer.from('tampered-content'));
    const hashRes = await h.completeUpload(req(operator, { params: { packageId: s2Data.packageId } }));
    assert.equal(hashRes.status, 400);

    // 签名不匹配：签名对其他型号（型号不匹配即签名不匹配）
    const sigFixture = makePackageFixture();
    const wrongModelSig = validSignature({ ...sigFixture.declared, model: 'BNX-OTHER' });
    const s3 = await createSession(h, { ...sigFixture.body, signature: wrongModelSig });
    const s3Data = (s3.body as DataBody).data;
    store.objects.set(s3Data.objectKey, sigFixture.content);
    const sigRes = await h.completeUpload(req(operator, { params: { packageId: s3Data.packageId } }));
    assert.equal(sigRes.status, 400);
    assert.match((sigRes.body as ErrBody).error.message, /signature/i);

    for (const id of [s1Data.packageId, s2Data.packageId, s3Data.packageId]) {
      const row = await prisma.firmwarePackage.findUnique({ where: { id } });
      assert.equal(row?.status, 'UPLOADED', `${id} 拒绝后不得进入 VERIFIED`);
    }
  });

  test('签名策略未冻结 → 409 失败关闭；verifier 与策略算法错配 → 409', async () => {
    // provisional 策略：验签失败关闭，包停留 UPLOADED
    const pending = handlers({ policy: pendingPolicy });
    const { session } = await createAndUpload(pending.h, pending.store);
    const res = await pending.h.completeUpload(req(operator, { params: { packageId: session.packageId } }));
    assert.equal(res.status, 409);
    assert.equal((res.body as ErrBody).error.code, 'CONFLICT');
    assert.match((res.body as ErrBody).error.message, /not frozen|fail-closed/i);
    const row = await prisma.firmwarePackage.findUnique({ where: { id: session.packageId } });
    assert.equal(row?.status, 'UPLOADED');

    // verifier 算法与策略不一致 → 409（防接线错配）
    const mismatched = handlers({ verifierAlgorithm: 'RSA-PSS' });
    const up = await createAndUpload(mismatched.h, mismatched.store);
    const res2 = await mismatched.h.completeUpload(req(operator, { params: { packageId: up.session.packageId } }));
    assert.equal(res2.status, 409);
  });

  test('病毒扫描 adapter：INFECTED → 400 拒绝；CLEAN → 放行（未装配时不扫描）', async () => {
    const infected = handlers({ malwareScanner: { scan: async () => 'INFECTED' } });
    const up1 = await createAndUpload(infected.h, infected.store);
    const res1 = await infected.h.completeUpload(req(operator, { params: { packageId: up1.session.packageId } }));
    assert.equal(res1.status, 400);
    assert.match((res1.body as ErrBody).error.message, /malware/i);

    const clean = handlers({ malwareScanner: { scan: async () => 'CLEAN' } });
    const up2 = await createAndUpload(clean.h, clean.store);
    const res2 = await clean.h.completeUpload(req(operator, { params: { packageId: up2.session.packageId } }));
    assert.equal(res2.status, 200);
  });

  test('成功 → 200 VERIFIED + 审计；重复完成 → 409（成功包不可覆盖）；不存在 → 404', async () => {
    const { h, store } = handlers({});
    const { session } = await createAndUpload(h, store);

    const res = await h.completeUpload(req(superAdmin, { params: { packageId: session.packageId } }));
    assert.equal(res.status, 200);
    const view = (res.body as DataBody).data;
    assert.equal(view.status, 'VERIFIED');
    assert.equal(view.packageId, session.packageId);

    const row = await prisma.firmwarePackage.findUnique({ where: { id: session.packageId } });
    assert.equal(row?.status, 'VERIFIED');
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'firmware_package', objectId: session.packageId, action: 'ota.package.verify' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');

    // 重复完成 → 409（不可覆盖）
    const again = await h.completeUpload(req(superAdmin, { params: { packageId: session.packageId } }));
    assert.equal(again.status, 409);
    assert.equal((again.body as ErrBody).error.code, 'CONFLICT');

    // 不存在 → 404
    const missing = await h.completeUpload(req(superAdmin, { params: { packageId: 'pkg-unknown' } }));
    assert.equal(missing.status, 404);
    assert.equal((missing.body as ErrBody).error.code, 'NOT_FOUND');
  });

  test('存储内部错误 → 500 通用消息，不泄露 AWS 细节', async () => {
    const leakingStorage = {
      async statObject() {
        throw new Error('S3 HeadObject failed on arn:aws:s3:::fdp-ota-secret with access key denied');
      },
      async computeSha256() {
        return null;
      },
    };
    const { h, store } = handlers({ storage: leakingStorage });
    const fixture = makePackageFixture();
    const created = await createSession(h, fixture.body);
    const session = (created.body as DataBody).data;
    store.objects.set(session.objectKey, fixture.content); // 不影响：statObject 必抛错
    const res = await h.completeUpload(req(operator, { params: { packageId: session.packageId } }));
    assert.equal(res.status, 500);
    const err = (res.body as ErrBody).error;
    assert.equal(err.code, 'INTERNAL_ERROR');
    assert.equal(err.message, 'Internal server error');
    assert.ok(!JSON.stringify(res.body).includes('arn:aws'));
  });
});

describe('BE-OTA-01 列表与详情', () => {
  test('可发布列表 = VERIFIED：UPLOADED 不进入；筛选 model/packageType/status；键集游标分页', async () => {
    const { h, store } = handlers({});
    const model = 'BNX-LIST';
    const p1 = await createAndUpload(h, store, model);
    const p2 = await createAndUpload(h, store, model);
    const p3 = await createAndUpload(h, store, model);
    // 只完成 p1/p3 → VERIFIED；p2 保持 UPLOADED
    assert.equal((await h.completeUpload(req(operator, { params: { packageId: p1.session.packageId } }))).status, 200);
    assert.equal((await h.completeUpload(req(operator, { params: { packageId: p3.session.packageId } }))).status, 200);

    const publishable = await h.listPackages(req(auditor, { query: { status: 'VERIFIED', model } }));
    const publishableIds = (publishable.body as ListBody).data.map((p) => p.packageId);
    assert.deepEqual(publishableIds.sort(), [p1.session.packageId, p3.session.packageId].sort());
    assert.ok(!publishableIds.includes(p2.session.packageId), '未完成上传不进入可发布列表');

    const uploadedOnly = await h.listPackages(req(auditor, { query: { status: 'UPLOADED', model } }));
    assert.deepEqual(
      (uploadedOnly.body as ListBody).data.map((p) => p.packageId),
      [p2.session.packageId],
    );

    const byType = await h.listPackages(req(auditor, { query: { model, packageType: 'APP' } }));
    assert.equal((byType.body as ListBody).data.length, 0);

    // 非法筛选值 → 400
    assert.equal((await h.listPackages(req(auditor, { query: { status: 'PUBLISHED' } }))).status, 400);
    assert.equal((await h.listPackages(req(auditor, { query: { packageType: 'OS' } }))).status, 400);

    // 键集游标分页（limit=1 翻页取全 3 条）
    const page1 = await h.listPackages(req(auditor, { query: { model, limit: '1' } }));
    const body1 = page1.body as ListBody;
    assert.equal(body1.data.length, 1);
    assert.ok(body1.meta.nextCursor);
    const page2 = await h.listPackages(req(auditor, { query: { model, limit: '1', cursor: body1.meta.nextCursor } }));
    const page3 = await h.listPackages(
      req(auditor, { query: { model, limit: '1', cursor: (page2.body as ListBody).meta.nextCursor } }),
    );
    const collected = [
      ...(page1.body as ListBody).data,
      ...(page2.body as ListBody).data,
      ...(page3.body as ListBody).data,
    ].map((p) => p.packageId);
    assert.deepEqual(collected.sort(), [p1.session.packageId, p2.session.packageId, p3.session.packageId].sort());
  });

  test('详情：200；不存在 → 404；Customer 角色无 ota:read → 403', async () => {
    const { h, store } = handlers({});
    const { session, fixture } = await createAndUpload(h, store);

    const res = await h.getPackage(req(auditor, { params: { packageId: session.packageId } }));
    assert.equal(res.status, 200);
    const view = (res.body as DataBody).data;
    assert.equal(view.packageId, session.packageId);
    assert.equal(view.status, 'UPLOADED');
    assert.equal(view.sha256, fixture.declared.sha256);
    assert.equal(view.uploadedBy, operator.actorId);
    // 详情不含预签名 URL/签名/信任根材料
    for (const forbidden of ['uploadUrl', 'signature', 'trustRoot']) {
      assert.ok(!(forbidden in view), `详情不得包含 ${forbidden}`);
    }

    assert.equal((await h.getPackage(req(auditor, { params: { packageId: 'pkg-unknown' } }))).status, 404);
    assert.equal((await h.getPackage(req(customerAdmin, { params: { packageId: session.packageId } }))).status, 403);
  });
});

test('错误码映射表与 CT-05 目录一致', () => {
  assert.deepEqual(ADMIN_OTA_PACKAGE_ERROR_HTTP_STATUS, { VALIDATION_FAILED: 400, NOT_FOUND: 404, CONFLICT: 409 });
});
