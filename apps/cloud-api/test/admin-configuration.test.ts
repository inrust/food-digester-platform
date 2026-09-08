/**
 * BE-CFG-01 Configuration 版本管理 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 四字段越界、候选扩展字段和未知字段均拒绝；
 * - 派生字段（contract/region/subregion/site/alias）不能随配置提交修改 → 400；
 * - DEC-018 排除的网络字段（cloudDomain/ntpServer）提交失败 → 400；
 * - 历史版本不可覆盖（重复发布 409、payload 无更新路径）；旧版本仍可审计读取；
 * - 发布生成 CONFIG_CHANGED（每目标设备一条 Outbox；Retired 不通知）；审计各一次；
 * - 发布后 Sync 读取路径（resolveEffectiveConfiguration）返回最新有效版本（设备定向优先）；
 * - 按设备/型号发布并查询同步状态（通知投递状态）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_CONFIGURATION_ERROR_HTTP_STATUS, createAdminConfigurationHandlers } from '../src/index.js';
import { resolveEffectiveConfiguration } from '../src/admin/configuration/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-29T12:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;

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
  return createAdminConfigurationHandlers({ client: prisma, now });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

function validPayload() {
  return {
    heartbeatInterval: 60,
    telemetryInterval: 30,
    cameraRefreshInterval: 1,
    temperatureThreshold: 80,
  };
}

let seq = 0;
/** 落库设备（默认 Active + 分配 Customer/Site，含别名与地域）。 */
async function plantDevice(options: { model?: string; lifecycle?: string; alias?: string } = {}) {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer CFG ${seq}` } });
  const site = await prisma.site.create({
    data: { customerId: customer.id, name: `Site CFG ${seq}`, region: `Region-${seq}`, subregion: `Sub-${seq}` },
  });
  const deviceId = `dev-cfg-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-CFG-${seq}`,
      model: options.model ?? 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycle ?? 'Active',
      customerId: customer.id,
      siteId: site.id,
      ...(options.alias !== undefined ? { alias: options.alias } : {}),
    },
  });
  return { deviceId, customerId: customer.id, siteId: site.id };
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

async function createDeviceConfig(h: ReturnType<typeof handlers>, deviceId: string) {
  const res = await h.create(req(operator, { body: { name: `Cfg ${deviceId}`, targetDeviceId: deviceId } }));
  assert.equal(res.status, 201);
  assertOpenApiResponse('createConfiguration', 201, res.body);
  return (res.body as DataBody).data;
}

async function createVersion(
  h: ReturnType<typeof handlers>,
  configurationId: string,
  payload: unknown = validPayload(),
) {
  const res = await h.createVersion(
    req(operator, { params: { configurationId }, body: { payload, changeNote: '变更' } }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assertOpenApiResponse('createConfigurationVersion', 201, res.body);
  return (res.body as DataBody).data;
}

describe('创建与校验', () => {
  test('创建配置（按设备/按型号）与不可变版本；版本号递增；二选一与目标校验', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice({ alias: '大堂一号机' });

    // 按设备创建
    const cfg = await createDeviceConfig(h, deviceId);
    assert.equal(cfg.targetDeviceId, deviceId);
    assert.equal(cfg.targetModel, null);
    // 按型号创建
    const modelRes = await h.create(req(superAdmin, { body: { name: 'Model Cfg', targetModel: 'BNX-100' } }));
    assert.equal(modelRes.status, 201);
    assert.equal((modelRes.body as DataBody).data.targetModel, 'BNX-100');

    // 版本号递增
    const v1 = await createVersion(h, cfg.configurationId as string);
    const v2 = await createVersion(h, cfg.configurationId as string, { ...validPayload(), heartbeatInterval: 120 });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(v1.status, 'DRAFT');
    assert.equal(v1.effectiveAt, null);

    // 二选一：都给/都不给 → 400
    assert.equal(
      (await h.create(req(operator, { body: { name: 'x', targetModel: 'M', targetDeviceId: deviceId } }))).status,
      400,
    );
    assert.equal((await h.create(req(operator, { body: { name: 'x' } }))).status, 400);
    // 目标设备不存在 → 404；Retired → 409
    assert.equal((await h.create(req(operator, { body: { name: 'x', targetDeviceId: 'dev-missing' } }))).status, 404);
    const retired = await plantDevice({ lifecycle: 'Retired' });
    assert.equal(
      (await h.create(req(operator, { body: { name: 'x', targetDeviceId: retired.deviceId } }))).status,
      409,
    );
    // 审计：configuration.create 恰好一次（按设备）
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: deviceId, action: 'configuration.create', result: 'SUCCESS' } }),
      1,
    );
  });

  test('冻结范围外数值与 V1 候选扩展字段均拒绝', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const cfg = await createDeviceConfig(h, deviceId);
    const configurationId = cfg.configurationId as string;

    const invalidPayloads: [string, Record<string, unknown>][] = [
      ['非法频率 heartbeatInterval', { ...validPayload(), heartbeatInterval: 9 }],
      ['非法频率 telemetryInterval', { ...validPayload(), telemetryInterval: 4 }],
      ['非法频率 cameraRefreshInterval', { ...validPayload(), cameraRefreshInterval: 1441 }],
      ['非法阈值 temperatureThreshold', { ...validPayload(), temperatureThreshold: 121 }],
      ['候选字段 image', { ...validPayload(), image: { width: 640, height: 480, uploadIntervalSeconds: 300 } }],
      ['候选字段 heating', { ...validPayload(), heating: { minTemperatureCelsius: 55, maxTemperatureCelsius: 55 } }],
      ['候选字段 rotation', { ...validPayload(), rotation: { intervalMinutes: 1, durationSeconds: 60 } }],
      ['候选字段 motor', { ...validPayload(), motor: { overloadCurrentAmps: 100 } }],
      ['候选字段 language', { ...validPayload(), language: 'fr-FR' }],
      ['未知字段', { ...validPayload(), extra: 1 }],
    ];
    for (const [name, payload] of invalidPayloads) {
      const res = await h.createVersion(req(operator, { params: { configurationId }, body: { payload } }));
      assert.equal(res.status, 400, `${name} 必须 400`);
      assert.equal((res.body as ErrorBody).error.code, 'VALIDATION_FAILED');
    }
    // 缺字段
    const missing = { ...validPayload() } as Record<string, unknown>;
    delete missing.cameraRefreshInterval;
    assert.equal(
      (await h.createVersion(req(operator, { params: { configurationId }, body: { payload: missing } }))).status,
      400,
    );
    // 全部拒绝：版本数恒为 0
    assert.equal(await prisma.configurationVersion.count({ where: { configurationId } }), 0);
  });

  test('派生字段不能随配置提交修改；V1 排除的网络字段提交失败', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const cfg = await createDeviceConfig(h, deviceId);
    const configurationId = cfg.configurationId as string;

    for (const key of ['contract', 'region', 'subregion', 'site', 'alias']) {
      const res = await h.createVersion(
        req(operator, { params: { configurationId }, body: { payload: { ...validPayload(), [key]: 'x' } } }),
      );
      assert.equal(res.status, 400, `派生字段 ${key} 必须 400`);
      assert.match((res.body as ErrorBody).error.message, /derived|read-only/i);
    }
    for (const key of ['cloudDomain', 'ntpServer']) {
      const res = await h.createVersion(
        req(operator, { params: { configurationId }, body: { payload: { ...validPayload(), [key]: 'x' } } }),
      );
      assert.equal(res.status, 400, `V1 排除字段 ${key} 必须 400`);
      assert.match((res.body as ErrorBody).error.message, /excluded/i);
    }
  });
});

describe('发布与不可变性', () => {
  test('发布生成 CONFIG_CHANGED（每目标设备一条；Retired 不通知）；审计一次；重复发布 409；旧版本可审计读取', async () => {
    const h = handlers();
    // 型号配置：2 台同型号 + 1 台其他型号 + 1 台同型号 Retired
    const d1 = await plantDevice({ model: 'BNX-300' });
    const d2 = await plantDevice({ model: 'BNX-300' });
    await plantDevice({ model: 'BNX-100' });
    const dRetired = await plantDevice({ model: 'BNX-300', lifecycle: 'Retired' });

    const createRes = await h.create(req(superAdmin, { body: { name: 'Model Cfg 300', targetModel: 'BNX-300' } }));
    const configurationId = (createRes.body as DataBody).data.configurationId as string;
    const v1 = await createVersion(h, configurationId);
    const v2 = await createVersion(h, configurationId, { ...validPayload(), heartbeatInterval: 90 });

    // 发布 v1
    const pub1 = await h.publishVersion(req(operator, { params: { configurationId, version: '1' }, body: {} }));
    assert.equal(pub1.status, 200, JSON.stringify(pub1.body));
    const pub1Data = (pub1.body as DataBody).data;
    assert.equal((pub1Data.version as Record<string, unknown>).status, 'PUBLISHED');
    assert.deepEqual([...(pub1Data.notifiedDeviceIds as string[])].sort(), [d1.deviceId, d2.deviceId].sort());
    assert.ok(!(pub1Data.notifiedDeviceIds as string[]).includes(dRetired.deviceId), 'Retired 不通知');

    // CONFIG_CHANGED Outbox 恰好 2 条（每目标设备一条，aggregateId = versionId）
    const outboxRows = await prisma.outboxEvent.findMany({
      where: { aggregateId: v1.versionId as string, eventType: 'CONFIG_CHANGED' },
    });
    assert.equal(outboxRows.length, 2);
    for (const row of outboxRows) {
      const payload = row.payload as { topic: string; data: { type: string; action: string } };
      assert.match(payload.topic, /^bnx\/device\/dev-cfg-\d+\/notification$/);
      assert.deepEqual(payload.data, { type: 'CONFIG_CHANGED', action: 'SYNC' });
    }
    // 审计恰好一次
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: v1.versionId as string, action: 'configuration.publish' } }),
      1,
    );

    // 重复发布 → 409（历史版本不可覆盖）
    const republish = await h.publishVersion(req(operator, { params: { configurationId, version: '1' }, body: {} }));
    assert.equal(republish.status, 409);
    assert.equal((republish.body as ErrorBody).error.code, 'CONFLICT');

    // 发布 v2 后：v1 旧版本仍可审计读取且 payload 未被覆盖
    const pub2 = await h.publishVersion(req(operator, { params: { configurationId, version: '2' }, body: {} }));
    assert.equal(pub2.status, 200);
    const oldVersion = await h.getVersion(req(auditor, { params: { configurationId, version: '1' } }));
    assert.equal(oldVersion.status, 200);
    const oldData = (oldVersion.body as DataBody).data;
    assert.equal(oldData.status, 'PUBLISHED');
    assert.equal((oldData.payload as Record<string, unknown>).heartbeatInterval, 60, 'v1 payload 未被 v2 覆盖');
    assert.equal((v2 as Record<string, unknown>).versionId !== (v1 as Record<string, unknown>).versionId, true);

    // 同步状态：v1 两个目标均 PENDING 投递
    const status = await h.versionStatus(req(operator, { params: { configurationId, version: '1' } }));
    assert.equal(status.status, 200);
    const statusData = (status.body as DataBody).data;
    assert.equal(statusData.status, 'PUBLISHED');
    assert.equal((statusData.targets as unknown[]).length, 2);
    for (const t of statusData.targets as { deviceId: string; notificationStatus: string }[]) {
      assert.equal(t.notificationStatus, 'PENDING');
    }
    // DRAFT 版本（未发布）无通知目标
    const v3 = await createVersion(h, configurationId);
    const draftStatus = await h.versionStatus(
      req(operator, { params: { configurationId, version: String(v3.version) } }),
    );
    assert.equal(((draftStatus.body as DataBody).data.targets as unknown[]).length, 0);
  });

  test('发布后 Sync 读取路径返回最新有效版本；未来生效不返回；设备定向优先于型号定向', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice({ model: 'BNX-400' });

    // 型号配置：发布 v1（已生效）
    const modelCfg = await h.create(req(superAdmin, { body: { name: 'Model Cfg 400', targetModel: 'BNX-400' } }));
    const modelCfgId = (modelCfg.body as DataBody).data.configurationId as string;
    await createVersion(h, modelCfgId);
    assert.equal(
      (await h.publishVersion(req(operator, { params: { configurationId: modelCfgId, version: '1' }, body: {} })))
        .status,
      200,
    );

    // Sync 读取：型号配置 v1
    let effective = await resolveEffectiveConfiguration({ client: prisma, now }, deviceId);
    assert.ok(effective);
    assert.equal(effective.configurationId, modelCfgId);
    assert.equal(effective.version, 1);

    // 发布 v2（未来生效）→ Sync 仍返回 v1
    await createVersion(h, modelCfgId, { ...validPayload(), heartbeatInterval: 90 });
    await h.publishVersion(
      req(operator, {
        params: { configurationId: modelCfgId, version: '2' },
        body: { effectiveAt: new Date(NOW.getTime() + DAY_MS).toISOString() },
      }),
    );
    effective = await resolveEffectiveConfiguration({ client: prisma, now }, deviceId);
    assert.equal(effective?.version, 1, '未来生效版本不应下发');

    // v2 到点生效 → Sync 返回最新有效版本
    effective = await resolveEffectiveConfiguration(
      { client: prisma, now },
      deviceId,
      new Date(NOW.getTime() + 2 * DAY_MS),
    );
    assert.equal(effective?.version, 2);

    // 设备定向配置优先于型号定向
    const devCfg = await createDeviceConfig(h, deviceId);
    const devCfgId = devCfg.configurationId as string;
    await createVersion(h, devCfgId, { ...validPayload(), heartbeatInterval: 45 });
    await h.publishVersion(req(operator, { params: { configurationId: devCfgId, version: '1' }, body: {} }));
    effective = await resolveEffectiveConfiguration({ client: prisma, now }, deviceId);
    assert.equal(effective?.configurationId, devCfgId);
    assert.equal((effective?.payload as unknown as Record<string, unknown>).heartbeatInterval, 45);

    // 无配置设备 → null；设备不存在 → 404
    const orphan = await plantDevice({ model: 'BNX-OTHER' });
    assert.equal(await resolveEffectiveConfiguration({ client: prisma, now }, orphan.deviceId), null);
    try {
      await resolveEffectiveConfiguration({ client: prisma, now }, 'dev-missing');
      assert.fail('should throw');
    } catch (err) {
      assert.equal((err as { code: string }).code, 'NOT_FOUND');
    }
  });
});

describe('详情与权限', () => {
  test('详情含派生只读上下文（Alias/Site/Region/Subregion/Contract）；权限矩阵', async () => {
    const h = handlers();
    const { deviceId, customerId } = await plantDevice({ alias: '后门二号机' });
    await prisma.contract.create({
      data: {
        contractNumber: `CT-CFG-${seq}`,
        name: '服务合同',
        customerId,
        startAt: new Date(NOW.getTime() - DAY_MS),
        endAt: new Date(NOW.getTime() + 30 * DAY_MS),
        status: 'EFFECTIVE',
        createdBy: 'admin-1',
      },
    });
    const cfg = await createDeviceConfig(h, deviceId);
    const configurationId = cfg.configurationId as string;
    await createVersion(h, configurationId);

    const detail = await h.detail(req(auditor, { params: { configurationId } }));
    assert.equal(detail.status, 200);
    const data = (detail.body as DataBody).data;
    assert.equal((data.versions as unknown[]).length, 1);
    const ctx = data.derivedContext as Record<string, unknown>;
    assert.equal(ctx.alias, '后门二号机');
    assert.equal(typeof ctx.site, 'string');
    assert.equal(typeof ctx.region, 'string');
    assert.equal(typeof ctx.subregion, 'string');
    assert.equal((ctx.contract as Record<string, unknown>).contractNumber, `CT-CFG-${seq}`);

    // 型号配置无派生上下文
    const modelCfg = await h.create(req(superAdmin, { body: { name: 'Model Only', targetModel: 'BNX-100' } }));
    const modelDetail = await h.detail(
      req(auditor, { params: { configurationId: (modelCfg.body as DataBody).data.configurationId as string } }),
    );
    assert.equal((modelDetail.body as DataBody).data.derivedContext, null);

    // 列表过滤
    const list = await h.list(req(auditor, { query: { targetDeviceId: deviceId } }));
    assert.equal(list.status, 200);
    assert.equal((list.body as { data: unknown[] }).data.length, 1);

    // 权限：Auditor 读放行/写 403；CustomerAdmin 读写均 403；未认证 401
    assert.equal((await h.create(req(auditor, { body: { name: 'x', targetModel: 'M' } }))).status, 403);
    assert.equal(
      (await h.publishVersion(req(auditor, { params: { configurationId, version: '1' }, body: {} }))).status,
      403,
    );
    assert.equal((await h.detail(req(customerAdmin, { params: { configurationId } }))).status, 403);
    assert.equal((await h.list(req(customerAdmin, {}))).status, 403);
    assert.equal((await h.detail(req(undefined, { params: { configurationId } }))).status, 401);
    // 不存在 → 404
    assert.equal((await h.detail(req(auditor, { params: { configurationId: 'cfg-missing' } }))).status, 404);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminConfigurationError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_CONFIGURATION_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('DTO 字段与 OpenAPI 契约一致', async () => {
    const api = loadJson('admin-configuration-api.json');
    const h = handlers();
    const { deviceId } = await plantDevice();
    const cfg = await createDeviceConfig(h, deviceId);
    assert.deepEqual(
      Object.keys(cfg).sort(),
      [...api.components.schemas.ConfigurationSummary.required].sort(),
      'ConfigurationSummary DTO 与契约一致',
    );
    const v = await createVersion(h, cfg.configurationId as string);
    assert.deepEqual(
      Object.keys(v).sort(),
      [...api.components.schemas.ConfigurationVersion.required].sort(),
      'ConfigurationVersion DTO 与契约一致',
    );
    // 载荷字段与契约 required 一致
    assert.deepEqual(
      Object.keys(validPayload()).sort(),
      [...api.components.schemas.ConfigurationPayload.required].sort(),
      'ConfigurationPayload 字段与契约一致',
    );
  });

  test('admin/configuration 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/configuration/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
