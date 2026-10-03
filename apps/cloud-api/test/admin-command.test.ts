/**
 * BE-CMD-01 Command 创建与授权 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 22 个命令矩阵覆盖（ACTIVE 全部放行；SUSPENDED/MAINTENANCE 仅安全停止/诊断/同步子集；
 *   RETIRED 全部拒绝）；
 * - 无 Entitlement（无 License / Entitlement 停用 / License 过期）失败（403）；
 * - DEC-023 高风险命令：客户端仅提交 confirmText；可信 JWT auth_time 缺失/过期/未来均 403；
 * - 越权失败（CustomerViewer/Auditor 无 command:send → 403；跨 Customer → 404）；
 * - meta.id 幂等（重复创建 200 replayed，无新写入/审计；语义冲突 409）；
 * - requestedBy 不信任客户端；expiresAt = requestTime + timeoutSec 服务器计算；审计齐备。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_COMMAND_ERROR_HTTP_STATUS, createAdminCommandHandlers } from '../src/index.js';
import type { AdminCommandHandlerDeps, AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../contracts/mqtt/command-catalog.json', import.meta.url)), 'utf8'),
) as { commands: { command: string; category: string; highRisk: boolean; allowedStatuses: string[] }[] };
const ALL_COMMANDS = catalog.commands;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-30T15:00:00Z');

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
  authenticatedAt: NOW.toISOString(),
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

function handlers(at: Date = NOW) {
  const deps: AdminCommandHandlerDeps = { client: prisma, now: () => at };
  return createAdminCommandHandlers(deps);
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return { actor, headers: {}, requestId: `req-${Math.random().toString(36).slice(2)}`, ...options };
}

type DataBody = { data: Record<string, any>; meta: Record<string, any> };
type ErrorBody = { error: { code: string } };

let seq = 0;

interface TenantFixture {
  customerId: string;
  deviceId: string;
  customerAdmin: ActorContext;
  customerViewer: ActorContext;
}

async function plantTenant(options: {
  lifecycleStatus?: string;
  operationalStatus?: string | null;
  entitlement?: { code: string; enabled: boolean } | null;
  licenseExpired?: boolean;
  noLicense?: boolean;
}): Promise<TenantFixture> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `CMD ${seq}` } });
  const deviceId = `dev-cmd-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-CMD-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
      customerId: customer.id,
    },
  });
  if (options.operationalStatus !== undefined && options.operationalStatus !== null) {
    await prisma.deviceLatestState.create({
      data: { deviceId, customerId: customer.id, operationalStatus: options.operationalStatus },
    });
  }
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
    const ent = options.entitlement === undefined ? { code: 'REMOTE_CONTROL', enabled: true } : options.entitlement;
    if (ent !== null) {
      await prisma.licenseEntitlement.create({ data: { licenseId: license.id, code: ent.code, enabled: ent.enabled } });
    }
  }
  const customerAdmin: ActorContext = {
    actorId: `ca-${seq}`,
    username: `ca-${seq}`,
    actorType: 'customer',
    roles: ['CustomerAdmin'],
    customerId: customer.id,
    tokenUse: 'access',
    authenticatedAt: NOW.toISOString(),
  };
  const customerViewer: ActorContext = { ...customerAdmin, actorId: `cv-${seq}`, roles: ['CustomerViewer'] };
  return { customerId: customer.id, deviceId, customerAdmin, customerViewer };
}

/** 高风险命令附带合法确认凭证。 */
function bodyFor(spec: { command: string; highRisk: boolean }, extra: Record<string, unknown> = {}) {
  return {
    command: spec.command,
    timeoutSec: 60,
    ...(spec.highRisk ? { confirmation: { confirmText: spec.command } } : {}),
    ...extra,
  };
}

describe('22 命令矩阵', () => {
  test('ACTIVE 设备：22 个命令全部创建成功并进入 AUTHORIZED', async () => {
    const tenant = await plantTenant({});
    const h = handlers();
    for (const spec of ALL_COMMANDS) {
      const res = await h.createCommand(
        req(tenant.customerAdmin, { params: { deviceId: tenant.deviceId }, body: bodyFor(spec) }),
      );
      assert.equal(res.status, 201, `${spec.command}: ${JSON.stringify(res.body)}`);
      const data = (res.body as DataBody).data;
      assert.equal(data.status, 'AUTHORIZED');
      assert.equal(data.command, spec.command);
      assert.equal(data.category, spec.category);
      assert.equal(data.highRisk, spec.highRisk);
      assert.equal(data.confirmedBy, spec.highRisk ? tenant.customerAdmin.actorId : null);
      assert.equal(data.replayed, false);
    }
    const count = await prisma.deviceCommand.count({ where: { deviceId: tenant.deviceId } });
    assert.equal(count, 22);
  });

  test('SUSPENDED（云端 lifecycle）：仅 allowedStatuses 子集放行；启动处理类 DEVICE_STATE_NOT_ALLOWED', async () => {
    const tenant = await plantTenant({ lifecycleStatus: 'Suspended' });
    const h = handlers();
    for (const spec of ALL_COMMANDS) {
      const res = await h.createCommand(
        req(tenant.customerAdmin, { params: { deviceId: tenant.deviceId }, body: bodyFor(spec) }),
      );
      if (spec.allowedStatuses.includes('SUSPENDED')) {
        assert.equal(res.status, 201, `${spec.command} 在 Suspended 下应放行`);
      } else {
        assert.equal(res.status, 409, `${spec.command} 在 Suspended 下应拒绝`);
        assert.equal((res.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');
      }
    }
  });

  test('MAINTENANCE（设备上报 operationalStatus）：限制与 Suspended 相同', async () => {
    const tenant = await plantTenant({ operationalStatus: 'Maintenance' });
    const h = handlers();
    for (const spec of ALL_COMMANDS) {
      const res = await h.createCommand(
        req(superAdmin, { params: { deviceId: tenant.deviceId }, body: bodyFor(spec) }),
      );
      if (spec.allowedStatuses.includes('MAINTENANCE')) {
        assert.equal(res.status, 201, `${spec.command} 在 Maintenance 下应放行`);
      } else {
        assert.equal(res.status, 409, `${spec.command} 在 Maintenance 下应拒绝`);
      }
    }
  });

  test('RETIRED：22 个命令全部拒绝', async () => {
    const tenant = await plantTenant({ lifecycleStatus: 'Retired' });
    const h = handlers();
    for (const spec of ALL_COMMANDS) {
      const res = await h.createCommand(
        req(superAdmin, { params: { deviceId: tenant.deviceId }, body: bodyFor(spec) }),
      );
      assert.equal(res.status, 409, `${spec.command} 在 Retired 下应拒绝`);
      assert.equal((res.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');
    }
  });
});

describe('Entitlement 门', () => {
  test('无 License / Entitlement 停用 / License 过期 → 403 FORBIDDEN', async () => {
    const noLicense = await plantTenant({ noLicense: true });
    const disabled = await plantTenant({ entitlement: { code: 'REMOTE_CONTROL', enabled: false } });
    const expired = await plantTenant({ licenseExpired: true });
    const otherEnt = await plantTenant({ entitlement: { code: 'OTA_UPDATE', enabled: true } });
    const h = handlers();
    for (const tenant of [noLicense, disabled, expired, otherEnt]) {
      const res = await h.createCommand(
        req(superAdmin, { params: { deviceId: tenant.deviceId }, body: bodyFor({ command: 'STOP', highRisk: false }) }),
      );
      assert.equal(res.status, 403, '无 REMOTE_CONTROL 有效授权应失败');
      assert.equal((res.body as ErrorBody).error.code, 'FORBIDDEN');
    }
  });
});

describe('DEC-023 高风险确认凭证', () => {
  test('缺失/confirmText 不符/客户端时间字段 → 400；缺失/过期/未来可信 auth_time → 403', async () => {
    const tenant = await plantTenant({});
    const h = handlers();
    const post = (body: Record<string, unknown>) =>
      h.createCommand(req(tenant.customerAdmin, { params: { deviceId: tenant.deviceId }, body }));

    assert.equal((await post({ command: 'EMERGENCY_STOP', timeoutSec: 60 })).status, 400, '缺确认');
    assert.equal(
      (
        await post({
          command: 'EMERGENCY_STOP',
          timeoutSec: 60,
          confirmation: { confirmText: 'STOP' },
        })
      ).status,
      400,
      'confirmText 不符',
    );
    const forgedTime = await post({
      command: 'FACTORY_RESET',
      timeoutSec: 60,
      confirmation: { confirmText: 'FACTORY_RESET', confirmedAt: NOW.toISOString() },
    });
    assert.equal(forgedTime.status, 400, '客户端确认时间字段必须拒绝');
    const { authenticatedAt: _ignored, ...withoutAuthenticatedAt } = tenant.customerAdmin;
    const invalidActors: ActorContext[] = [
      withoutAuthenticatedAt,
      { ...tenant.customerAdmin, authenticatedAt: new Date(NOW.getTime() - 301_000).toISOString() },
      { ...tenant.customerAdmin, authenticatedAt: new Date(NOW.getTime() + 120_000).toISOString() },
    ];
    for (const actor of invalidActors) {
      const res = await h.createCommand(
        req(actor, {
          params: { deviceId: tenant.deviceId },
          body: { command: 'SHUTDOWN', timeoutSec: 60, confirmation: { confirmText: 'SHUTDOWN' } },
        }),
      );
      assert.equal(res.status, 403, `auth_time=${actor.authenticatedAt ?? 'missing'}`);
      assert.equal((res.body as ErrorBody).error.code, 'FORBIDDEN');
    }
    assert.equal(await prisma.deviceCommand.count({ where: { deviceId: tenant.deviceId } }), 0, '失败请求不落库');
  });

  test('近期重新认证放行，并在 command.authorize 审计记录 DEC-023 与可信时间', async () => {
    const tenant = await plantTenant({});
    const res = await handlers().createCommand(
      req(tenant.customerAdmin, {
        params: { deviceId: tenant.deviceId },
        body: { command: 'FACTORY_RESET', timeoutSec: 60, confirmation: { confirmText: 'FACTORY_RESET' } },
      }),
    );
    assert.equal(res.status, 201);
    const commandId = (res.body as DataBody).data.commandId;
    const audit = await prisma.auditLog.findFirst({ where: { objectId: commandId, action: 'command.authorize' } });
    const after = audit?.afterValue as Record<string, unknown>;
    assert.equal(after.confirmationDecision, 'DEC-023@1.0.0');
    assert.equal(after.confirmationMethod, 'RECENT_REAUTHENTICATION_AND_EXPLICIT_TEXT');
    assert.equal(after.authenticatedAt, NOW.toISOString());
  });
});

describe('越权与租户隔离', () => {
  test('CustomerViewer/Auditor 无 command:send → 403；跨 Customer → 404；未认证 → 401', async () => {
    const tenant = await plantTenant({});
    const other = await plantTenant({});
    const h = handlers();
    const body = bodyFor({ command: 'STOP', highRisk: false });

    assert.equal(
      (await h.createCommand(req(tenant.customerViewer, { params: { deviceId: tenant.deviceId }, body }))).status,
      403,
    );
    assert.equal((await h.createCommand(req(auditor, { params: { deviceId: tenant.deviceId }, body }))).status, 403);
    assert.equal(
      (await h.createCommand(req(other.customerAdmin, { params: { deviceId: tenant.deviceId }, body }))).status,
      404,
    );
    assert.equal((await h.createCommand(req(undefined, { params: { deviceId: tenant.deviceId }, body }))).status, 401);
    // Operator（平台）有 command:send
    assert.equal((await h.createCommand(req(operator, { params: { deviceId: tenant.deviceId }, body }))).status, 201);
  });
});

describe('meta.id 幂等与服务器计算字段', () => {
  test('重复创建（同 commandId 同语义）→ 200 replayed 无新写入/审计；冲突 → 409', async () => {
    const tenant = await plantTenant({});
    const h = handlers();
    const body = { commandId: 'CMD-IDEM-1', command: 'STOP', timeoutSec: 60, remarks: '首次' };

    const first = await h.createCommand(req(tenant.customerAdmin, { params: { deviceId: tenant.deviceId }, body }));
    assert.equal(first.status, 201);
    const second = await h.createCommand(req(tenant.customerAdmin, { params: { deviceId: tenant.deviceId }, body }));
    assert.equal(second.status, 200);
    assert.equal((second.body as DataBody).data.replayed, true);

    assert.equal(await prisma.deviceCommand.count({ where: { id: 'CMD-IDEM-1' } }), 1);
    const audits = await prisma.auditLog.count({ where: { objectType: 'device_command', objectId: 'CMD-IDEM-1' } });
    assert.equal(audits, 1, '重放无新增审计');

    // 语义冲突（不同 timeoutSec / command）→ 409
    const conflict = await h.createCommand(
      req(tenant.customerAdmin, { params: { deviceId: tenant.deviceId }, body: { ...body, timeoutSec: 120 } }),
    );
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as ErrorBody).error.code, 'CONFLICT');
  });

  test('requestedBy 不信任客户端；expiresAt=requestTime+timeoutSec；审计落库', async () => {
    const tenant = await plantTenant({});
    const h = handlers();
    const res = await h.createCommand(
      req(tenant.customerAdmin, {
        params: { deviceId: tenant.deviceId },
        body: {
          command: 'STOP',
          timeoutSec: 120,
          requestedBy: 'spoofed',
          requestTime: '2020-01-01T00:00:00Z',
          expiresAt: '2020-01-01T00:00:00Z',
        },
      }),
    );
    assert.equal(res.status, 201);
    const data = (res.body as DataBody).data;
    assert.equal(data.requestedBy, tenant.customerAdmin.actorId, 'requestedBy 取身份上下文');
    assert.equal(data.requestTime, NOW.toISOString());
    assert.equal(data.expiresAt, new Date(NOW.getTime() + 120_000).toISOString(), 'expiresAt 服务器内部计算');

    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'device_command', objectId: data.commandId },
    });
    assert.ok(audit);
    assert.equal(audit.action, 'command.authorize');
    assert.equal(audit.actorId, tenant.customerAdmin.actorId);
  });

  test('校验：未知命令 / timeoutSec 越界 → 400；设备不存在 → 404', async () => {
    const tenant = await plantTenant({});
    const h = handlers();
    const post = (deviceId: string, body: Record<string, unknown>) =>
      h.createCommand(req(tenant.customerAdmin, { params: { deviceId }, body }));

    assert.equal((await post(tenant.deviceId, { command: 'SELF_DESTRUCT', timeoutSec: 60 })).status, 400);
    assert.equal((await post(tenant.deviceId, { command: 'STOP', timeoutSec: 0 })).status, 400);
    assert.equal((await post(tenant.deviceId, { command: 'STOP', timeoutSec: 3601 })).status, 400);
    assert.equal((await post(tenant.deviceId, { command: 'STOP' })).status, 400);
    assert.equal((await post('dev-missing', { command: 'STOP', timeoutSec: 60 })).status, 404);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminCommandError 错误码与 CT-05 错误码目录一致', () => {
    const catalogJson = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_COMMAND_ERROR_HTTP_STATUS)) {
      assert.equal(catalogJson.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('响应字段与 OpenAPI 契约一致；模块无 AWS 依赖', async () => {
    const api = loadJson('admin-command-api.json');
    const tenant = await plantTenant({});
    const h = handlers();
    const res = await h.createCommand(
      req(tenant.customerAdmin, {
        params: { deviceId: tenant.deviceId },
        body: bodyFor({ command: 'STOP', highRisk: false }),
      }),
    );
    assert.equal(res.status, 201);
    const data = (res.body as DataBody).data;
    assert.deepEqual(Object.keys(data).sort(), [...api.components.schemas.CommandView.required].sort());

    const dir = fileURLToPath(new URL('../src/admin/command/', import.meta.url));
    for (const file of ['errors.ts', 'service.ts', 'handler.ts', 'publisher.ts', 'index.ts']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});

describe('QA-09 committed command notification', () => {
  test('notification observes committed command/outbox and failed delivery preserves durable authorization', async () => {
    const f = await plantTenant({});
    let notices = 0,
      failures = 0;
    const commandId = 'QA09-COMMITTED-NOTIFY';
    const h = createAdminCommandHandlers({
      client: prisma,
      now: () => NOW,
      notifyAuthorizedCommand: async (id) => {
        notices++;
        assert.equal(id, commandId);
        assert.isNotNull(await prisma.deviceCommand.findUnique({ where: { id } }));
        assert.equal(
          await prisma.outboxEvent.count({ where: { aggregateId: id, eventType: 'COMMAND_PUBLISH_REQUESTED' } }),
          1,
        );
        throw Error('synthetic queue unavailable');
      },
      onImmediatePublishFailure: () => {
        failures++;
      },
    });
    for (let i = 0; i < 2; i++) {
      const response = await h.createCommand(
        req(operator, {
          params: { deviceId: f.deviceId },
          body: { commandId, command: 'FORCE_SYNC', timeoutSec: 120 },
        }),
      );
      assert.equal(response.status, i === 0 ? 201 : 200);
    }
    assert.equal(notices, 2);
    assert.equal(failures, 2);
    const command = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: commandId } });
    assert.equal(command.status, 'AUTHORIZED');
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: commandId } }), 1);
  });
  test('outbox failure rolls back command authorization and emits no notification', async () => {
    const f = await plantTenant({});
    const commandId = 'QA09-ROLLBACK-NOTIFY';
    let notices = 0;
    await prisma.outboxEvent.create({
      data: {
        eventType: 'COMMAND_PUBLISH_REQUESTED',
        aggregateType: 'device_command',
        aggregateId: commandId,
        idempotencyKey: 'COMMAND_PUBLISH_REQUESTED:' + commandId,
        payload: { commandId },
      },
    });
    const h = createAdminCommandHandlers({
      client: prisma,
      now: () => NOW,
      notifyAuthorizedCommand: async () => {
        notices++;
      },
    });
    const response = await h.createCommand(
      req(operator, { params: { deviceId: f.deviceId }, body: { commandId, command: 'FORCE_SYNC', timeoutSec: 120 } }),
    );
    assert.equal(response.status, 500);
    assert.isNull(await prisma.deviceCommand.findUnique({ where: { id: commandId } }));
    assert.equal(notices, 0);
  });
});
