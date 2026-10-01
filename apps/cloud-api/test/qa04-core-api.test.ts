import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { assert, test } from 'vitest';
import type { ActorContext, Role } from '@fdp/auth';
import {
  createAdminDeviceHandlers,
  createAdminDeviceStatusHandlers,
  createAdminContractHandlers,
  createAdminAuditHandlers,
} from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

const ROLES: Role[] = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
const NOW = new Date('2026-10-01T03:00:00Z');
async function withFixture(
  name: string,
  run: (
    db: Awaited<ReturnType<typeof createTestDb>>,
    prefix: string,
    customers: string[],
    devices: string[],
  ) => Promise<Record<string, unknown>>,
) {
  const db = await createTestDb();
  const prefix = `QA04-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const customers = [`${prefix}-A`, `${prefix}-B`];
  const devices = customers.map((id) => `${id}-DEV`);
  let proof: Record<string, unknown> | undefined;
  try {
    for (const [index, id] of customers.entries()) {
      await db.prisma.customer.create({ data: { id, name: id } });
      await db.prisma.device.create({
        data: {
          id: devices[index]!,
          serialNumber: devices[index]!,
          model: 'BNX-100',
          hardwareVersion: 'HW1.0',
          manufacturer: 'Hiddenjoy',
          manufactureDate: NOW,
          customerId: id,
          lifecycleStatus: 'Active',
        },
      });
    }
    for (const [index, deviceId] of devices.entries())
      await db.prisma.deviceLatestState.create({
        data: { deviceId, customerId: customers[index]!, operationalStatus: 'Active' },
      });
    proof = await run(db, prefix, customers, devices);
  } finally {
    await db.prisma.$disconnect();
    await db.pg.close();
  }
  if (proof && process.env.QA04_TRACE)
    appendFileSync(
      process.env.QA04_TRACE,
      JSON.stringify({ kind: 'proof', name, status: 'PASS', prefix, customers, cleanup: 'PASS', ...proof }) + '\n',
    );
}
function actor(role: Role, customerId: string): ActorContext {
  return {
    actorId: `QA04-${role}`,
    username: role,
    actorType: role.startsWith('Customer') ? 'customer' : 'platform',
    roles: [role],
    customerId: role.startsWith('Customer') ? customerId : null,
    tokenUse: 'access',
    authenticatedAt: NOW.toISOString(),
  };
}
function req(role: Role, customerId: string, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return { actor: actor(role, customerId), headers: {}, requestId: `QA04-${randomUUID()}`, ...options };
}

test('QA04 five roles, two tenants: read scope, mutation and audit boundaries', async () => {
  await withFixture('five-roles-two-tenants', async ({ prisma }, _prefix, customers, devices) => {
    const views = createAdminDeviceHandlers({ client: prisma, now: () => NOW });
    const statuses = createAdminDeviceStatusHandlers({ client: prisma, now: () => NOW });
    const audits = createAdminAuditHandlers({ client: prisma, now: () => NOW });
    const matrix = [];
    for (const role of ROLES) {
      const own = await views.detail(req(role, customers[0]!, { params: { deviceId: devices[0]! } }));
      const cross = await views.detail(req(role, customers[0]!, { params: { deviceId: devices[1]! } }));
      assert.equal(own.status, 200);
      assert.equal(cross.status, role.startsWith('Customer') ? 403 : 200);
      const auditCountBefore = await prisma.auditLog.count();
      const audit = await audits.listAuditLogs(req(role, customers[0]!));
      assert.equal(audit.status, ['PlatformSuperAdmin', 'Auditor'].includes(role) ? 200 : 403);
      assert.equal(await prisma.auditLog.count(), auditCountBefore);
      const deviceId = `${devices[0]}-${role}`;
      await prisma.device.create({
        data: {
          id: deviceId,
          serialNumber: deviceId,
          model: 'BNX-100',
          hardwareVersion: 'HW1.0',
          manufacturer: 'Hiddenjoy',
          manufactureDate: NOW,
          customerId: customers[0]!,
          lifecycleStatus: 'Active',
        },
      });
      await prisma.deviceLatestState.create({
        data: { deviceId, customerId: customers[0]!, operationalStatus: 'Active' },
      });
      const mutate = await statuses.suspend(
        req(role, customers[0]!, { params: { deviceId }, body: { reason: 'QA04 permission matrix' } }),
      );
      const allowed = ['PlatformSuperAdmin', 'PlatformOperator'].includes(role);
      assert.equal(mutate.status, allowed ? 200 : 403);
      assert.equal(
        (await prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).lifecycleStatus,
        allowed ? 'Suspended' : 'Active',
      );
      assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: deviceId } }), allowed ? 1 : 0);
      assert.equal(await prisma.deviceStateHistory.count({ where: { deviceId } }), allowed ? 2 : 0);
      assert.equal(await prisma.auditLog.count({ where: { objectId: deviceId, result: 'SUCCESS' } }), allowed ? 1 : 0);
      matrix.push({ role, own: own.status, cross: cross.status, suspend: mutate.status, audit: audit.status });
    }
    assert.equal(
      (await views.detail({ headers: {}, requestId: 'QA04-unauthenticated', params: { deviceId: devices[0]! } }))
        .status,
      401,
    );
    return { roles: ROLES, matrix, unauthorizedNoBusinessWrites: true };
  });
}, 60_000);

test('QA04 concurrent If-Match writes have one winner and one success audit', async () => {
  await withFixture('if-match-race', async ({ prisma }, prefix, customers) => {
    const contract = await prisma.contract.create({
      data: {
        contractNumber: prefix,
        name: prefix,
        customerId: customers[0]!,
        status: 'DRAFT',
        startAt: new Date('2026-01-01'),
        endAt: new Date('2027-01-01'),
        createdBy: prefix,
      },
    });
    const h = createAdminContractHandlers({ client: prisma, now: () => NOW });
    const results = await Promise.all(
      ['winner-a', 'winner-b'].map((name) =>
        h.update(
          req('PlatformSuperAdmin', customers[0]!, {
            params: { contractId: contract.id },
            headers: { 'If-Match': '1' },
            body: { name, reason: 'QA04 concurrent update' },
          }),
        ),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (results.find((r) => r.status === 409)!.body as { error: { code: string } }).error.code,
      'VERSION_CONFLICT',
    );
    const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    assert.equal(stored.version, 2);
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: contract.id, action: 'contract.update', result: 'SUCCESS' } }),
      1,
    );
    assert.equal(
      (
        await h.update(
          req('PlatformSuperAdmin', customers[0]!, {
            params: { contractId: contract.id },
            headers: { 'If-Match': '1' },
            body: { name: 'stale', reason: 'QA04 stale retry' },
          }),
        )
      ).status,
      409,
    );
    assert.deepEqual(await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } }), stored);
    return { statuses: [200, 409], version: 2, successAudits: 1, staleRetryNoWrites: true };
  });
}, 60_000);

test('QA04 audit failure rolls back lifecycle/outbox; retry and replay preserve exactly one audit', async () => {
  await withFixture('atomic-audit-replay', async ({ prisma, pg }, _prefix, customers, devices) => {
    const h = createAdminDeviceStatusHandlers({ client: prisma, now: () => NOW });
    const input = req('PlatformOperator', customers[0]!, {
      params: { deviceId: devices[0]! },
      body: { reason: 'QA04 suspension' },
    });
    await pg.exec(
      `CREATE FUNCTION qa04_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA04 audit unavailable'; END $$; CREATE TRIGGER qa04_reject BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa04_reject_audit();`,
    );
    const failed = await h.suspend(input);
    assert.equal(failed.status, 500);
    assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: devices[0]! } })).lifecycleStatus, 'Active');
    assert.equal(await prisma.deviceStateHistory.count(), 0);
    assert.equal(await prisma.outboxEvent.count(), 0);
    assert.equal(await prisma.auditLog.count(), 0);
    await pg.exec('DROP TRIGGER qa04_reject ON audit_logs; DROP FUNCTION qa04_reject_audit();');
    assert.equal((await h.suspend(input)).status, 200);
    const before = await Promise.all([
      prisma.deviceStateHistory.count(),
      prisma.outboxEvent.count(),
      prisma.auditLog.count(),
    ]);
    const replay = await h.suspend(input);
    assert.equal(replay.status, 200);
    assert.equal((replay.body as { data: { replayed: boolean } }).data.replayed, true);
    assert.deepEqual(
      await Promise.all([prisma.deviceStateHistory.count(), prisma.outboxEvent.count(), prisma.auditLog.count()]),
      before,
    );
    assert.deepEqual(before, [2, 1, 1]);
    const audit = await prisma.auditLog.findFirstOrThrow();
    assert.equal(audit.actorId, input.actor!.actorId);
    assert.equal(audit.reason, 'QA04 suspension');
    assert.equal(audit.result, 'SUCCESS');
    assert.equal(
      (
        await h.reactivate(
          req('PlatformOperator', customers[0]!, {
            params: { deviceId: devices[0]! },
            body: { reason: 'QA04 resolved', issueResolved: true },
          }),
        )
      ).status,
      200,
    );
    assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: devices[0]! } })).lifecycleStatus, 'Active');
    return { rollback: true, replayNoWrites: true, successAudits: 1, reactivated: true };
  });
}, 60_000);
