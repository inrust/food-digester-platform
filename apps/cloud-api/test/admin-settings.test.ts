/**
 * BE-SET-01 业务设置与字典 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 非法配置拒绝：各 key 值 Schema（阈值层级倒置/负值/未知字段、ttlSec 越界、
 *   重定义固定命令目录字段、未知通知事件/渠道、空显示名）→ 400 且不落库；
 * - 并发修改冲突：携带过期 version 更新 → 409 VERSION_CONFLICT；
 * - 固定命令/Topic 不可被删除或重命名：字典仅允许为固定封闭集 code 维护显示名，
 *   未知 code / 未知 namespace → 400；无删除/新建 key 路由；
 * - 版本控制与审计：更新成功 version 自增 + settings.update 审计（before/after）；
 * - 权限：settings:read（SuperAdmin/Auditor 200）、settings:write 仅 SuperAdmin
 *   （Auditor/Operator/Customer 角色 → 403）；无 actor → 401。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminSettingsHandlers } from '../src/index.js';
import type { AdminHttpRequest, SettingsDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-05T13:00:00Z');

const superAdmin: ActorContext = {
  actorId: 'sub-set-super',
  username: 'super',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};

const auditor: ActorContext = {
  actorId: 'sub-set-auditor',
  username: 'auditor',
  actorType: 'platform',
  roles: ['Auditor'],
  customerId: null,
  tokenUse: 'access',
};

const operator: ActorContext = {
  actorId: 'sub-set-operator',
  username: 'operator',
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

const deps = (): SettingsDeps => ({ client: prisma, now: () => NOW });

const req = (actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest => ({
  actor,
  headers: {},
  requestId: `req-${Math.random()}`,
  ...options,
});

type DataBody = { data: any; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type ErrBody = { error: { code: string; message: string } };

const put = (
  h: ReturnType<typeof createAdminSettingsHandlers>,
  key: string,
  value: unknown,
  version: unknown,
  actor: ActorContext = superAdmin,
) => h.updateSetting(req(actor, { params: { key }, body: { value, version } }));

describe('BE-SET-01 读取与权限', () => {
  test('列表返回封闭 key 集种子；单项读取；未知 key → 404；Auditor 可读', async () => {
    const h = createAdminSettingsHandlers(deps());
    const list = await h.listSettings(req(auditor));
    assert.equal(list.status, 200);
    const keys = (list.body as ListBody).data.map((s) => s.key);
    assert.deepEqual(keys, [
      'alarm.thresholds',
      'command.confirmation',
      'dictionary.displayNames',
      'notification.business',
    ]);
    const runtime = Object.fromEntries(
      (list.body as ListBody).data.map((setting) => [setting.key, [setting.runtimeStatus, setting.runtimeConsumer]]),
    );
    assert.deepEqual(runtime['command.confirmation'], ['ACTIVE', 'BE-CMD-01']);
    assert.deepEqual(runtime['alarm.thresholds'], ['STORED_ONLY', null]);
    assert.deepEqual(runtime['dictionary.displayNames'], ['STORED_ONLY', null]);
    assert.deepEqual(runtime['notification.business'], ['STORED_ONLY', null]);

    const one = await h.getSetting(req(auditor, { params: { key: 'command.confirmation' } }));
    assert.equal(one.status, 200);
    const view = (one.body as DataBody).data;
    assert.deepEqual(view.value, { ttlSec: 300, maxFutureSec: 60 });
    assert.equal(view.version, 1);

    assert.equal((await h.getSetting(req(auditor, { params: { key: 'aws.budget' } }))).status, 404);
  });

  test('settings:write 仅 PlatformSuperAdmin；Operator 无 settings:read；无 actor → 401', async () => {
    const h = createAdminSettingsHandlers(deps());
    const body = { value: { ttlSec: 600, maxFutureSec: 60 }, version: 1 };
    // Auditor 可读不可写
    assert.equal((await h.updateSetting(req(auditor, { params: { key: 'command.confirmation' }, body }))).status, 403);
    // Operator 读写皆无
    assert.equal((await h.listSettings(req(operator))).status, 403);
    assert.equal((await h.updateSetting(req(operator, { params: { key: 'command.confirmation' }, body }))).status, 403);
    // Customer 角色无 settings 权限
    const cust: ActorContext = {
      actorId: 'sub-set-ca',
      username: 'ca',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: 'cust-1',
      tokenUse: 'access',
    };
    assert.equal((await h.listSettings(req(cust))).status, 403);
    // 无 actor → 401
    assert.equal((await h.listSettings(req(undefined))).status, 401);
    assert.equal(
      (await h.updateSetting(req(undefined, { params: { key: 'command.confirmation' }, body }))).status,
      401,
    );
  });
});

describe('BE-SET-01 更新与版本控制', () => {
  test('成功：version 自增 + updatedBy + 审计（before/after）', async () => {
    const h = createAdminSettingsHandlers(deps());
    const res = await put(h, 'command.confirmation', { ttlSec: 600, maxFutureSec: 120 }, 1);
    assert.equal(res.status, 200);
    const view = (res.body as DataBody).data;
    assert.equal(view.version, 2);
    assert.equal(view.updatedBy, superAdmin.actorId);
    assert.deepEqual(view.value, { ttlSec: 600, maxFutureSec: 120 });

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'business_setting', objectId: 'command.confirmation', action: 'settings.update' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.deepEqual(audits[0]?.beforeValue, { value: { ttlSec: 300, maxFutureSec: 60 }, version: 1 });
    assert.deepEqual(audits[0]?.afterValue, { value: { ttlSec: 600, maxFutureSec: 120 }, version: 2 });
  });

  test('并发修改冲突：过期 version → 409 VERSION_CONFLICT 且不落库', async () => {
    const h = createAdminSettingsHandlers(deps());
    // 当前 version=2（上一用例已更新）；携带 version=1 → 409
    const stale = await put(h, 'command.confirmation', { ttlSec: 900, maxFutureSec: 60 }, 1);
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrBody).error.code, 'VERSION_CONFLICT');
    // 值未变化
    const row = await prisma.businessSetting.findUnique({ where: { key: 'command.confirmation' } });
    assert.equal(row?.version, 2);
    assert.deepEqual(row?.value, { ttlSec: 600, maxFutureSec: 120 });
    // 正确 version 仍可更新
    assert.equal((await put(h, 'command.confirmation', { ttlSec: 900, maxFutureSec: 60 }, 2)).status, 200);
  });
});

describe('BE-SET-01 非法配置拒绝（400 且不落库）', () => {
  test('alarm.thresholds：层级倒置/负值/未知字段/空条目/非对象', async () => {
    const h = createAdminSettingsHandlers(deps());
    const cases: unknown[] = [
      'not-an-object',
      { TEMP_HIGH: { warning: 80, major: 70 } }, // 层级倒置
      { TEMP_HIGH: { warning: -1 } }, // 负值
      { TEMP_HIGH: { warning: 'hot' } }, // 非数值
      { TEMP_HIGH: { warning: 10, p0: 1 } }, // 未知字段
      { TEMP_HIGH: {} }, // 空条目
    ];
    for (const value of cases) {
      const res = await put(h, 'alarm.thresholds', value, 1);
      assert.equal(res.status, 400, JSON.stringify(value));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    // 合法：仅定义部分层级且保序
    assert.equal((await put(h, 'alarm.thresholds', { TEMP_HIGH: { warning: 70, critical: 90 } }, 1)).status, 200);
  });

  test('command.confirmation：越界/非整数/缺字段/重定义固定命令目录字段', async () => {
    const h = createAdminSettingsHandlers(deps());
    const cases: unknown[] = [
      { ttlSec: 10, maxFutureSec: 60 }, // 越界（< 30）
      { ttlSec: 7200, maxFutureSec: 60 }, // 越界（> 3600）
      { ttlSec: 300.5, maxFutureSec: 60 }, // 非整数
      { ttlSec: 300 }, // 缺 maxFutureSec
      { ttlSec: 300, maxFutureSec: 60, highRiskCommands: ['START'] }, // 重定义固定目录 → 拒绝
    ];
    for (const value of cases) {
      const res = await put(h, 'command.confirmation', value, 3);
      assert.equal(res.status, 400, JSON.stringify(value));
    }
  });

  test('固定命令/Topic 不可被删除或重命名：未知 code/namespace → 400；已知 code 显示名放行', async () => {
    const h = createAdminSettingsHandlers(deps());
    const cases: unknown[] = [
      { command: { LAUNCH: '发射' } }, // 未知命令 code（固定目录之外）
      { topicType: { metrics: '指标' } }, // 未知 Topic type
      { notificationType: { DEVICE_BORN: '出生' } }, // 未知 Notification type
      { region: { CN: '中国' } }, // 未知 namespace
      { command: { START: '' } }, // 空显示名
    ];
    for (const value of cases) {
      const res = await put(h, 'dictionary.displayNames', value, 1);
      assert.equal(res.status, 400, JSON.stringify(value));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    // 固定封闭集内 code → 放行（仅显示名，不改枚举本身）
    const ok = await put(
      h,
      'dictionary.displayNames',
      {
        command: { START: '启动', EMERGENCY_STOP: '紧急停止' },
        topicType: { telemetry: '遥测' },
        notificationType: { OTA_AVAILABLE: '固件可升级' },
      },
      1,
    );
    assert.equal(ok.status, 200);
    // 固定目录本身未被改写（枚举来自代码/契约，不经过设置表）
    const row = await prisma.businessSetting.findUnique({ where: { key: 'dictionary.displayNames' } });
    assert.deepEqual(row?.value, {
      command: { START: '启动', EMERGENCY_STOP: '紧急停止' },
      topicType: { telemetry: '遥测' },
      notificationType: { OTA_AVAILABLE: '固件可升级' },
    });
  });

  test('notification.business：未知事件/渠道/空数组/重复 → 400', async () => {
    const h = createAdminSettingsHandlers(deps());
    const cases: unknown[] = [
      { eventTypes: ['DEVICE_BORN'], channels: ['EMAIL'] },
      { eventTypes: ['CRITICAL_ALERT_RAISED'], channels: ['SMS'] },
      { eventTypes: [], channels: ['EMAIL'] },
      { eventTypes: ['CRITICAL_ALERT_RAISED', 'CRITICAL_ALERT_RAISED'], channels: ['EMAIL'] },
      { eventTypes: ['CRITICAL_ALERT_RAISED'], channels: ['EMAIL'], slackWebhook: 'x' },
    ];
    for (const value of cases) {
      const res = await put(h, 'notification.business', value, 1);
      assert.equal(res.status, 400, JSON.stringify(value));
    }
    assert.equal(
      (
        await put(
          h,
          'notification.business',
          { eventTypes: ['CRITICAL_ALERT_RAISED'], channels: ['EMAIL', 'WEBHOOK'] },
          1,
        )
      ).status,
      200,
    );
  });

  test('版本字段校验：version 缺失/非正整数 → 400；未知 key 写入 → 404', async () => {
    const h = createAdminSettingsHandlers(deps());
    const missing = await h.updateSetting(
      req(superAdmin, { params: { key: 'alarm.thresholds' }, body: { value: {} } }),
    );
    assert.equal(missing.status, 400);
    assert.equal((await put(h, 'alarm.thresholds', {}, 0)).status, 400);
    assert.equal((await put(h, 'alarm.thresholds', {}, 'v1')).status, 400);
    assert.equal((await put(h, 'topic.catalog', {}, 1)).status, 404);
  });

  test('严格请求：未知顶层字段与数组 body 在 DB/审计前返回 400', async () => {
    const h = createAdminSettingsHandlers(deps());
    const before = await prisma.businessSetting.findUniqueOrThrow({ where: { key: 'alarm.thresholds' } });
    const beforeAudits = await prisma.auditLog.count();
    const unknown = await h.updateSetting(
      req(superAdmin, {
        params: { key: 'alarm.thresholds' },
        body: { value: {}, version: before.version, ignored: true },
      }),
    );
    const array = await h.updateSetting(
      req(superAdmin, { params: { key: 'alarm.thresholds' }, body: [{ value: {}, version: before.version }] }),
    );
    assert.equal(unknown.status, 400);
    assert.equal(array.status, 400);
    assert.equal(
      (await prisma.businessSetting.findUniqueOrThrow({ where: { key: 'alarm.thresholds' } })).version,
      before.version,
    );
    assert.equal(await prisma.auditLog.count(), beforeAudits);
  });
});
