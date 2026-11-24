/**
 * BE-CNS-02 耗材更换申请工作流 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - “未处理→正在处理→完成处理”完整链路可复验（PENDING→PROCESSING→COMPLETED）；
 * - 跳级、重复处理（409）、跨 Customer（404 租户隔离）和未授权角色（403）失败；
 * - 同设备同耗材开放申请重复创建幂等返回现有记录；
 * - 状态迁移 If-Match；完成后保留完整历史（申请时间/来源/处理人/备注/完成时间 + 审计）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { certificateFingerprintFromPem } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_CONSUMABLE_ERROR_HTTP_STATUS, createAdminConsumableRequestHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';
import { createAjv } from '../../../contracts/testing/device-contract.js';
import { createDeviceApiLambdaHandler } from '../src/runtime/device-lambda.js';
import {
  createDeviceConsumableSubmissionHandler,
  DEVICE_CONSUMABLE_REQUEST_PATH,
} from '../src/device/consumable-request-handler.js';
import { parseVerifiedDeviceClientTargets } from '../src/device/verified-client-targets.js';
import { parseConsumableRequestTime } from '../src/consumable/request-policy.js';

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
  return createAdminConsumableRequestHandlers({ client: prisma, now });
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

let seq = 0;
async function plantDevice(options: { withCustomer?: boolean; lifecycle?: string } = {}) {
  seq += 1;
  let customerId: string | undefined;
  if (options.withCustomer !== false) {
    const customer = await prisma.customer.create({ data: { name: `Customer REQ ${seq}` } });
    customerId = customer.id;
  }
  const deviceId = `dev-req-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-REQ-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycle ?? 'Active',
      ...(customerId ? { customerId } : {}),
    },
  });
  return { deviceId, customerId };
}

async function createReq(h: ReturnType<typeof handlers>, deviceId: string, consumableType = 'CARBON_FILTER') {
  const res = await h.create(req(superAdmin, { body: { deviceId, consumableType, note: '余量不足' } }));
  return res;
}

async function auditCount(requestId: string, action: string) {
  return prisma.auditLog.count({ where: { objectId: requestId, action, result: 'SUCCESS' } });
}

describe('完整链路：未处理→正在处理→完成处理', () => {
  test('创建→处理→完成；每步状态/处理人/备注/完成时间/审计', async () => {
    const h = handlers();
    const { deviceId, customerId } = await plantDevice();

    // 创建（PENDING，source=ADMIN，requestedBy/requestedAt）
    const created = await createReq(h, deviceId);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assertOpenApiResponse('createConsumableRequest', 201, created.body);
    const c = (created.body as DataBody).data;
    assert.equal(c.status, 'PENDING');
    assert.equal(c.source, 'ADMIN');
    assert.equal(c.requestedBy, 'admin-1');
    assert.equal(c.customerId, customerId);
    assert.equal(c.replayed, false);
    assert.equal(c.version, 1);
    const application = { note: '余量不足', source: 'RECORDED' };
    const handling = { note: '已派单', source: 'RECORDED' };
    const completion = { note: '已更换碳滤网', source: 'RECORDED' };
    assert.deepEqual(c.stageNotes, { request: application });
    const requestId = c.requestId as string;

    // 列表/详情可见
    const detail = await h.detail(req(auditor, { params: { requestId } }));
    assert.equal(detail.status, 200);
    assert.equal((detail.body as DataBody).data.status, 'PENDING');

    // 处理 PENDING→PROCESSING（processedBy 记录）
    const processing = await h.process(writeReq(operator, 1, { params: { requestId }, body: { note: '已派单' } }));
    assert.equal(processing.status, 200, JSON.stringify(processing.body));
    assert.equal((processing.body as DataBody).data.status, 'PROCESSING');
    assert.equal((processing.body as DataBody).data.processedBy, 'op-1');
    assert.equal((processing.body as DataBody).data.version, 2);
    assert.deepEqual((processing.body as DataBody).data.stageNotes, { request: application, processing: handling });

    // 完成 PROCESSING→COMPLETED（completedAt + processNote）
    const completed = await h.complete(
      writeReq(superAdmin, 2, { params: { requestId }, body: { note: '已更换碳滤网' } }),
    );
    assert.equal(completed.status, 200);
    const done = (completed.body as DataBody).data;
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.processNote, '已更换碳滤网');
    assert.deepEqual(done.stageNotes, { request: application, processing: handling, completion });
    assertOpenApiResponse('completeConsumableRequest', 200, completed.body);
    assert.equal(done.completedAt, NOW.toISOString());
    assert.equal(done.version, 3);

    // 审计：create/process/complete 各恰好一次（完成后保留完整历史）
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: deviceId, action: 'consumable.request.create', result: 'SUCCESS' },
      }),
      1,
    );
    assert.equal(await auditCount(requestId, 'consumable.request.process'), 1);
    assert.equal(await auditCount(requestId, 'consumable.request.complete'), 1);
    // 终态行保留（可再查询）
    const kept = await h.detail(req(auditor, { params: { requestId } }));
    assert.equal((kept.body as DataBody).data.status, 'COMPLETED');
    assert.deepEqual((kept.body as DataBody).data.stageNotes, done.stageNotes);
    const list = await h.list(req(auditor, { query: { deviceId } }));
    assert.deepEqual((list.body as ListBody).data[0]?.stageNotes, done.stageNotes);
    assertOpenApiResponse('listConsumableRequests', 200, list.body);
  });

  test('跳级/重复处理/终态迁移 409；缺 If-Match 400；If-Match 漂移 409 VERSION_CONFLICT；缺强制备注 400', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const created = await createReq(h, deviceId);
    const requestId = (created.body as DataBody).data.requestId as string;

    // 跳级 PENDING→COMPLETED → 409
    const skip = await h.complete(writeReq(superAdmin, 1, { params: { requestId }, body: { note: '跳级' } }));
    assert.equal(skip.status, 409);
    assert.equal((skip.body as ErrorBody).error.code, 'CONFLICT');
    // 缺 If-Match → 400
    assert.equal((await h.process(req(operator, { params: { requestId }, body: {} }))).status, 400);
    // 完成缺备注 → 400
    assert.equal((await h.complete(writeReq(superAdmin, 1, { params: { requestId }, body: {} }))).status, 400);
    // 正常推进到 PROCESSING
    await h.process(writeReq(operator, 1, { params: { requestId }, body: {} }));
    // If-Match 漂移（version 1 已消费）→ 409 VERSION_CONFLICT（状态校验合法但版本漂移）
    const stale = await h.cancel(writeReq(superAdmin, 1, { params: { requestId }, body: { note: 'x' } }));
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrorBody).error.code, 'VERSION_CONFLICT');
    // 完成
    await h.complete(writeReq(operator, 2, { params: { requestId }, body: { note: 'done' } }));
    // 重复处理（COMPLETED→PROCESSING）→ 409
    assert.equal((await h.process(writeReq(operator, 3, { params: { requestId }, body: {} }))).status, 409);
    // 重复完成 → 409
    assert.equal((await h.complete(writeReq(operator, 3, { params: { requestId }, body: { note: 'x' } }))).status, 409);
    // 写被拒后无审计污染
    assert.equal(await auditCount(requestId, 'consumable.request.process'), 1);
  });

  test('取消路径：PENDING→CANCELLED 强制原因；CANCELLED 终态不可再迁移', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const created = await createReq(h, deviceId);
    const requestId = (created.body as DataBody).data.requestId as string;
    // 取消缺原因 → 400
    assert.equal((await h.cancel(writeReq(superAdmin, 1, { params: { requestId }, body: {} }))).status, 400);
    const cancelled = await h.cancel(writeReq(superAdmin, 1, { params: { requestId }, body: { note: '误报' } }));
    assert.equal(cancelled.status, 200);
    assert.equal((cancelled.body as DataBody).data.status, 'CANCELLED');
    assert.deepEqual((cancelled.body as DataBody).data.stageNotes, {
      request: { note: '余量不足', source: 'RECORDED' },
      cancellation: { note: '误报', source: 'RECORDED' },
    });
    assert.equal(
      (await h.process(writeReq(superAdmin, 2, { params: { requestId }, body: {} }))).status,
      409,
      '终态不可迁移',
    );
    assert.equal(await auditCount(requestId, 'consumable.request.cancel'), 1);
  });
});

describe('幂等与冲突', () => {
  test('同设备同耗材开放申请重复创建幂等返回现有记录；终态后可再申请；不同耗材互不影响', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const first = await createReq(h, deviceId, 'CARBON_FILTER');
    const firstId = (first.body as DataBody).data.requestId as string;

    // 重复申请 → 200 replayed=true 返回现有记录，无新行/审计
    const dup = await h.create(
      req(superAdmin, { body: { deviceId, consumableType: 'CARBON_FILTER', note: '重复申请' } }),
    );
    assert.equal(dup.status, 200);
    const d = (dup.body as DataBody).data;
    assert.equal(d.requestId, firstId);
    assert.equal(d.replayed, true);
    assert.deepEqual(d.stageNotes, { request: { note: '余量不足', source: 'RECORDED' } });
    assert.equal(await prisma.consumableRequest.count({ where: { deviceId, consumableType: 'CARBON_FILTER' } }), 1);
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: deviceId, action: 'consumable.request.create', result: 'SUCCESS' },
      }),
      1,
    );

    // PROCESSING 仍属开放状态 → 幂等
    await h.process(writeReq(operator, 1, { params: { requestId: firstId }, body: {} }));
    const dup2 = await createReq(h, deviceId, 'CARBON_FILTER');
    assert.equal((dup2.body as DataBody).data.replayed, true);

    // 不同耗材互不影响
    const other = await createReq(h, deviceId, 'BIO_ADDITIVE');
    assert.equal(other.status, 201);
    assert.equal((other.body as DataBody).data.replayed, false);

    // 完成后可再申请（开放索引释放）
    await h.complete(writeReq(superAdmin, 2, { params: { requestId: firstId }, body: { note: 'done' } }));
    const again = await createReq(h, deviceId, 'CARBON_FILTER');
    assert.equal(again.status, 201);
    assert.equal((again.body as DataBody).data.replayed, false);
    assert.notEqual((again.body as DataBody).data.requestId, firstId);
  });

  test('非法类型 400；设备不存在 404；未分配 Customer/Retired 409', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    assert.equal((await h.create(req(superAdmin, { body: { deviceId, consumableType: 'CATALYST' } }))).status, 400);
    assert.equal(
      (await h.create(req(superAdmin, { body: { deviceId: 'dev-missing', consumableType: 'CARBON_FILTER' } }))).status,
      404,
    );
    const unassigned = await plantDevice({ withCustomer: false });
    assert.equal(
      (await h.create(req(superAdmin, { body: { deviceId: unassigned.deviceId, consumableType: 'CARBON_FILTER' } })))
        .status,
      409,
    );
    const retired = await plantDevice({ lifecycle: 'Retired' });
    assert.equal(
      (await h.create(req(superAdmin, { body: { deviceId: retired.deviceId, consumableType: 'CARBON_FILTER' } })))
        .status,
      409,
    );
  });
});

describe('权限与租户隔离', () => {
  test('未授权角色创建/处理 403；跨 Customer 详情 404；Customer 列表租户隔离；未认证 401', async () => {
    const h = handlers();
    const { deviceId, customerId } = await plantDevice();
    const created = await createReq(h, deviceId);
    const requestId = (created.body as DataBody).data.requestId as string;
    const customerAdmin: ActorContext = {
      ...superAdmin,
      actorId: 'ca-1',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: customerId as string,
    };
    const otherCustomerAdmin: ActorContext = { ...customerAdmin, actorId: 'ca-2', customerId: 'cust-other' };

    // CustomerAdmin 无 device:write → 创建/处理 403
    assert.equal(
      (await h.create(req(customerAdmin, { body: { deviceId, consumableType: 'BIO_ADDITIVE' } }))).status,
      403,
    );
    assert.equal((await h.process(writeReq(customerAdmin, 1, { params: { requestId }, body: {} }))).status, 403);
    assert.equal((await h.complete(writeReq(auditor, 1, { params: { requestId }, body: { note: 'x' } }))).status, 403);
    // CustomerAdmin 读本 Customer 放行；跨 Customer 详情 404
    assert.equal((await h.detail(req(customerAdmin, { params: { requestId } }))).status, 200);
    assert.equal((await h.detail(req(otherCustomerAdmin, { params: { requestId } }))).status, 404);
    const list = await h.list(req(otherCustomerAdmin, {}));
    assert.equal((list.body as ListBody).data.length, 0, '租户隔离：他 Customer 不可见');
    // Auditor 跨 Customer 只读
    assert.equal((await h.detail(req(auditor, { params: { requestId } }))).status, 200);
    // 未认证 401；不存在 404
    assert.equal((await h.list(req(undefined, {}))).status, 401);
    assert.equal((await h.detail(req(auditor, { params: { requestId: 'req-missing' } }))).status, 404);
    // 非法状态筛选 400
    assert.equal((await h.list(req(auditor, { query: { status: 'BOGUS' } }))).status, 400);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('错误码与 CT-05 目录一致；DTO 与 OpenAPI 契约一致', async () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_CONSUMABLE_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
    const api = loadJson('admin-consumable-request-api.json');
    const { deviceId } = await plantDevice();
    const created = await createReq(handlers(), deviceId);
    const data = (created.body as DataBody).data;
    assert.deepEqual(
      Object.keys(data).sort(),
      [...api.components.schemas.ConsumableRequest.required, 'stageNotes', 'replayed'].sort(),
    );
  });

  test('consumable 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/consumable/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});

test('R20 旧字段原样读回并在新版更新前留存；并发完成和取消只有胜方写入备注', async () => {
  const h = handlers();
  const { deviceId, customerId } = await plantDevice();
  const old = await prisma.consumableRequest.create({
    data: {
      customerId: customerId!,
      deviceId,
      consumableType: 'CARBON_FILTER',
      requestedBy: 'old',
      processNote: '旧来源未确认',
    },
  });
  const params = { requestId: old.id };
  const legacy = await h.detail(req(auditor, { params }));
  assert.deepEqual((legacy.body as DataBody).data.stageNotes, { legacy: ['旧来源未确认'] });
  const processing = await h.process(writeReq(operator, 1, { params, body: { note: '现场处理中' } }));
  assert.equal(processing.status, 200);
  const outcomes = await Promise.all([
    h.complete(writeReq(operator, 2, { params, body: { note: '更换结束' } })),
    h.cancel(writeReq(superAdmin, 2, { params, body: { note: '更换已取消' } })),
  ]);
  assert.deepEqual(outcomes.map((response) => response.status).sort(), [200, 409]);
  const stored = await prisma.consumableRequest.findUniqueOrThrow({ where: { id: old.id } });
  const winner = stored.status === 'COMPLETED' ? 'completion' : 'cancellation';
  const winnerNote = winner === 'completion' ? '更换结束' : '更换已取消';
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.stageNotes, {
    legacy: ['旧来源未确认'],
    processing: { note: '现场处理中', source: 'RECORDED' },
    [winner]: { note: winnerNote, source: 'RECORDED' },
  });
  assert.equal(stored.processNote, winnerNote);
  assert.equal(
    (await auditCount(old.id, 'consumable.request.complete')) + (await auditCount(old.id, 'consumable.request.cancel')),
    1,
  );
});

const T12_CLIENT = 't12-controlled-uplink.1';
const DAY = 86_400_000;

async function plantReportingDevice() {
  const { deviceId, customerId } = await plantDevice();
  const site = await prisma.site.create({ data: { customerId: customerId!, name: 'T12 受控站点' } });
  await prisma.device.update({ where: { id: deviceId }, data: { siteId: site.id } });
  const assignment = await prisma.deviceAssignment.create({
    data: {
      deviceId,
      customerId: customerId!,
      siteId: site.id,
      assignedBy: 't12-fixture',
      assignedAt: new Date(NOW.getTime() - 2 * DAY),
    },
  });
  const pem =
    '-----BEGIN CERTIFICATE-----\n' + Buffer.from(deviceId).toString('base64') + '\n-----END CERTIFICATE-----';
  await prisma.deviceCertificate.create({
    data: {
      deviceId,
      id: `t12-${deviceId}`,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      certificatePem: pem,
      packageCiphertext: Buffer.from('fixture'),
      notBefore: new Date(NOW.getTime() - 10 * DAY),
      notAfter: new Date(NOW.getTime() + 10 * DAY),
    },
  });
  return { deviceId, customerId: customerId!, siteId: site.id, assignmentId: assignment.id, pem };
}

type ReportingDevice = Awaited<ReturnType<typeof plantReportingDevice>>;

const closedRoutes = () => {
  const unused = async () => ({ status: 404, body: {} });
  return {
    certificateStatus: unused,
    certificateRotate: unused,
    sync: unused,
    deactivate: unused,
    otaDownload: unused,
    mediaUpload: unused,
  };
};

function deviceIntake(...devices: readonly ReportingDevice[]) {
  const verifiedTargets = parseVerifiedDeviceClientTargets(
    JSON.stringify(Object.fromEntries(devices.map(({ deviceId }) => [deviceId, T12_CLIENT]))),
  );
  const router = createDeviceApiLambdaHandler({
    ...closedRoutes(),
    ...(verifiedTargets.size
      ? {
          submitConsumableRequest: createDeviceConsumableSubmissionHandler({ client: prisma, now, verifiedTargets }),
        }
      : {}),
  });
  return async (body: unknown, device?: ReportingDevice, forged?: ReportingDevice) => {
    const result = await router({
      httpMethod: 'POST',
      path: DEVICE_CONSUMABLE_REQUEST_PATH,
      body: JSON.stringify(body),
      ...(forged ? { identity: { clientCertPem: forged.pem } } : {}),
      requestContext: {
        requestId: 't12-device-intake',
        ...(device ? { identity: { clientCert: { clientCertPem: device.pem } } } : {}),
      },
    });
    return { status: result.statusCode, body: JSON.parse(result.body) as DataBody & ErrorBody };
  };
}

function deviceRequest(requestKey: string) {
  return {
    schemaVersion: 1,
    clientVersion: T12_CLIENT,
    requestKey,
    consumableType: 'CARBON_FILTER',
    occurredAt: new Date(NOW.getTime() - DAY).toISOString(),
    note: '设备检测到滤网需要更换',
  };
}

test('E/T12 R20 device TLS intake validates candidate schemas and reads work back through the admin workflow', async () => {
  const a = await plantReportingDevice();
  const b = await plantReportingDevice();
  const submit = deviceIntake(a, b);
  const initial = deviceRequest('offline-same-key');

  const ajv = createAjv();
  const rest = new URL('../../../contracts/rest/', import.meta.url);
  const host = 'https://fdp.test/contracts/rest/';
  const candidate = 'device-consumable-request-candidate.openapi.json';
  for (const file of ['openapi-base.json', 'admin-consumable-request-api.json', candidate]) {
    ajv.addSchema(JSON.parse(readFileSync(new URL(file, rest), 'utf8')), host + file);
  }
  const validate = (schema: string, data: unknown) => {
    const check = ajv.compile({ $ref: host + candidate + '#/components/schemas/' + schema });
    assert.isTrue(check(data), ajv.errorsText(check.errors));
  };
  validate('DeviceConsumableRequest', initial);
  assert.equal((await deviceIntake()(initial, a)).status, 404);
  assert.equal((await submit(initial, undefined, a)).status, 401);
  assert.equal((await deviceIntake(b)(initial, a)).status, 403);
  assert.equal((await submit({ ...initial, clientVersion: 'unverified-build' }, a)).status, 403);
  for (const invalid of [
    { ...initial, schemaVersion: 2 },
    { ...initial, deviceId: b.deviceId },
    { ...initial, customerId: b.customerId },
    { ...initial, consumableType: 'TYPE_NOT_IN_DEC_008' },
    { ...initial, occurredAt: '2026-08-32T12:00:00Z' },
    { ...initial, occurredAt: '2026-08-31T12:00:00Z' },
  ])
    assert.equal((await submit(invalid, a)).status, 400);
  assert.equal(await prisma.consumableDeviceSubmission.count({ where: { deviceId: a.deviceId } }), 0);

  const concurrent = await Promise.all([submit(initial, a), submit(initial, a)]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 201]);
  const first = concurrent.find(({ status }) => status === 201)!;
  validate('CreatedDeviceConsumableRequest', first.body);
  const id = first.body.data.requestId as string;
  assert.deepEqual(first.body.data, { requestKey: initial.requestKey, requestId: id, outcome: 'CREATED' });
  const replay = concurrent.find(({ status }) => status === 200)!;
  validate('ExistingDeviceConsumableRequest', replay.body);
  assert.deepEqual(replay.body.data, { requestKey: initial.requestKey, requestId: id, outcome: 'REPLAYED' });
  const reused = await submit({ ...initial, note: '不同载荷' }, a);
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const other = await submit(initial, b);
  assert.equal(other.status, 201);
  assert.notEqual(other.body.data.requestId, id);
  assert.isFalse(Object.hasOwn(first.body.data, 'customerId'));

  const admin = handlers();
  const params = { requestId: id };
  const owner: ActorContext = {
    ...superAdmin,
    actorType: 'customer',
    roles: ['CustomerViewer'],
    customerId: a.customerId,
  };
  const outsider = { ...owner, customerId: b.customerId };
  const detail = await admin.detail(req(owner, { params }));
  assertOpenApiResponse('getConsumableRequest', detail.status, detail.body);
  const pending = (detail.body as DataBody).data;
  assert.include(pending, { source: 'DEVICE', requestedBy: a.deviceId, customerId: a.customerId, status: 'PENDING' });
  assert.equal((await admin.detail(req(outsider, { params }))).status, 404);
  assert.equal((await admin.process(writeReq(auditor, 1, { params, body: { note: '越权' } }))).status, 403);
  assert.equal((await admin.process(writeReq(operator, 1, { params, body: { note: '处理人已接单' } }))).status, 200);
  const completed = await admin.complete(writeReq(operator, 2, { params, body: { note: '现场已更换' } }));
  assertOpenApiResponse('completeConsumableRequest', completed.status, completed.body);
  assert.deepEqual((completed.body as DataBody).data.stageNotes, {
    request: { note: initial.note, source: 'RECORDED' },
    processing: { note: '处理人已接单', source: 'RECORDED' },
    completion: { note: '现场已更换', source: 'RECORDED' },
  });
  const terminalReplay = await submit(initial, a);
  assert.deepEqual(terminalReplay.body.data, { requestKey: initial.requestKey, requestId: id, outcome: 'REPLAYED' });
  assert.equal(await prisma.consumableRequest.count({ where: { deviceId: a.deviceId } }), 1);
  const receipt = await prisma.consumableDeviceSubmission.findFirstOrThrow({ where: { deviceId: a.deviceId } });
  assert.equal(receipt.assignmentId, a.assignmentId);
  assert.equal(receipt.occurredAt.toISOString(), initial.occurredAt);
  const audit = await prisma.auditLog.findMany({
    where: { objectId: a.deviceId, action: 'consumable.request.create', result: 'SUCCESS' },
  });
  assert.lengthOf(audit, 1);
  assert.include(audit[0], { actorId: a.deviceId, actorRole: 'DEVICE', requestId: 't12-device-intake' });
});

test('E/T12 R20 intake rolls back on partial failure and old scope cannot be credited after reassignment', async () => {
  const a = await plantReportingDevice();
  const b = await plantReportingDevice();
  const submit = deviceIntake(a, b);
  const body = deviceRequest('partial-failure');
  await prisma.$executeRawUnsafe(`CREATE FUNCTION t12_fail_submission() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'controlled submission write failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER t12_fail_submission BEFORE INSERT ON consumable_device_submissions
    FOR EACH ROW EXECUTE FUNCTION t12_fail_submission()`);
  try {
    assert.equal((await submit(body, a)).status, 500);
    assert.equal(await prisma.consumableRequest.count({ where: { deviceId: a.deviceId } }), 0);
    assert.equal(await prisma.consumableDeviceSubmission.count({ where: { deviceId: a.deviceId } }), 0);
    assert.equal(await auditCount(a.deviceId, 'consumable.request.create'), 0);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER t12_fail_submission ON consumable_device_submissions');
    await prisma.$executeRawUnsafe('DROP FUNCTION t12_fail_submission()');
  }
  const success = await submit(body, a);
  assert.equal(success.status, 201);
  await prisma.device.update({ where: { id: a.deviceId }, data: { lifecycleStatus: 'Suspended' } });
  assert.equal((await submit(deviceRequest('suspended'), a)).status, 403);
  await prisma.device.update({
    where: { id: a.deviceId },
    data: { lifecycleStatus: 'Active', customerId: b.customerId, siteId: b.siteId },
  });
  const noAssignment = await submit(deviceRequest('no-current-assignment'), a);
  assert.equal(noAssignment.status, 409);
  const reassignedAt = new Date(NOW.getTime() - 1_000);
  await prisma.deviceAssignment.update({
    where: { id: a.assignmentId },
    data: { status: 'ENDED', endedAt: reassignedAt },
  });
  await prisma.deviceAssignment.create({
    data: {
      deviceId: a.deviceId,
      customerId: b.customerId,
      siteId: b.siteId,
      assignedBy: 'fixture',
      assignedAt: reassignedAt,
    },
  });
  for (const entry of [body, deviceRequest('first-late-submit')]) {
    const old = await submit(entry, a);
    assert.equal(old.status, 409);
    assert.notProperty(old.body, 'data');
  }
  const previousOpen = await submit({ ...deviceRequest('new-tenant-current-time'), occurredAt: NOW.toISOString() }, a);
  assert.equal(previousOpen.status, 409);
  assert.notProperty(previousOpen.body, 'data');
  const withDifferentType = await submit(
    {
      ...deviceRequest('current-tenant-different-type'),
      occurredAt: NOW.toISOString(),
      consumableType: 'BIO_ADDITIVE',
    },
    a,
  );
  assert.equal(withDifferentType.status, 201);
  assert.equal(
    (
      await prisma.consumableRequest.findUniqueOrThrow({
        where: { id: withDifferentType.body.data.requestId as string },
      })
    ).customerId,
    b.customerId,
  );
});

test('E/T12 R20 matching an open legacy request and closing the compatibility window preserve existing operations', async () => {
  const device = await plantReportingDevice();
  const submit = deviceIntake(device);
  const cutoff = parseConsumableRequestTime(new Date(NOW.getTime() + 500).toISOString());
  assert.isNull(parseConsumableRequestTime('2026-02-30T00:00:00Z'));
  const compatibility = createAdminConsumableRequestHandlers({ client: prisma, now, legacyCreateUntil: cutoff });
  const legacy = await createReq(compatibility, device.deviceId);
  assert.equal(legacy.status, 201);
  const adminId = (legacy.body as DataBody).data.requestId as string;
  const deviceBody = deviceRequest('coalesced-on-admin');
  const linked = await submit(deviceBody, device);
  assert.deepEqual(linked.body.data, { requestKey: deviceBody.requestKey, requestId: adminId, outcome: 'LINKED_OPEN' });
  const before = await compatibility.list(req(operator, { query: { deviceId: device.deviceId } }));
  assertOpenApiResponse('listConsumableRequests', before.status, before.body);
  assert.equal((before.body as ListBody).meta.legacyCreationOffered, false);
  const after = createAdminConsumableRequestHandlers({
    client: prisma,
    now: () => new Date(cutoff!),
    legacyCreateUntil: cutoff,
  });
  const blocked = await createReq(after, device.deviceId, 'BIO_ADDITIVE');
  assert.equal(blocked.status, 403);
  const current = await submit(
    { ...deviceBody, requestKey: 'device-own-application', consumableType: 'BIO_ADDITIVE' },
    device,
  );
  assert.equal(current.status, 201);
  const view = await after.list(req(operator, { query: { deviceId: device.deviceId } }));
  assert.deepEqual((view.body as ListBody).data.map(({ source }) => source).sort(), ['ADMIN', 'DEVICE']);
  const params = { requestId: adminId };
  assert.equal((await after.detail(req(operator, { params }))).status, 200);
  assert.equal((await after.process(writeReq(operator, 1, { params, body: { note: '处理旧工单' } }))).status, 200);
  assert.equal((await after.cancel(writeReq(operator, 2, { params, body: { note: '确认重复' } }))).status, 200);
  assert.deepEqual((await submit(deviceBody, device)).body.data, {
    requestKey: deviceBody.requestKey,
    requestId: adminId,
    outcome: 'REPLAYED',
  });
  const rolledBack = await createReq(handlers(), device.deviceId);
  assert.equal(rolledBack.status, 201);
  const legacyList = await handlers().list(req(operator));
  assert.notProperty((legacyList.body as ListBody).meta, 'legacyCreationOffered');
});

test('E/T12 R20 concurrent legacy and device intake create one open request', async () => {
  const device = await plantReportingDevice();
  const submit = deviceIntake(device);
  const [legacy, candidate] = await Promise.all([
    createReq(handlers(), device.deviceId),
    submit(deviceRequest('parallel-sources'), device),
  ]);
  assert.deepEqual([legacy.status, candidate.status].sort(), [200, 201]);
  assert.equal((legacy.body as DataBody).data.requestId, candidate.body.data.requestId);
  assert.equal(await prisma.consumableRequest.count({ where: { deviceId: device.deviceId } }), 1);
  assert.equal(await prisma.consumableDeviceSubmission.count({ where: { deviceId: device.deviceId } }), 1);
});
