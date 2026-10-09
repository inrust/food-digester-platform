import { rejects } from 'node:assert/strict';
import { beforeAll, afterAll, test, assert, vi } from 'vitest';
import type { ActorContext } from '@fdp/auth';
import { createTestDb } from './helpers.js';
import { createAdminContractHandlers } from '../src/admin/contract/handler.js';
import { updateContract } from '../src/admin/contract/service.js';
import { readContractForUpdate } from '../src/admin/contract/load-candidate.js';
let db: Awaited<ReturnType<typeof createTestDb>>;
const actor: ActorContext = {
  actorId: 'offline-admin',
  username: 'offline',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};
const now = () => new Date('2026-10-10T00:00:00Z');
let customerId: string,
  seq = 0,
  oldPool: string | undefined;
beforeAll(async () => {
  oldPool = process.env.FDP_DB_POOL_MAX;
  process.env.FDP_DB_POOL_MAX = '1';
  db = await createTestDb();
  customerId = (await db.prisma.customer.create({ data: { name: 'candidate offline' } })).id;
}, 60000);
afterAll(async () => {
  await db.prisma.$disconnect();
  await db.pg.close();
  if (oldPool === undefined) delete process.env.FDP_DB_POOL_MAX;
  else process.env.FDP_DB_POOL_MAX = oldPool;
});
async function seed(status = 'DRAFT') {
  return db.prisma.contract.create({
    data: {
      id: `offline-text-${++seq}`,
      contractNumber: `OFFLINE-${seq}`,
      name: 'before',
      customerId,
      contact: 'offline@example.invalid',
      startAt: new Date('2026-01-01Z'),
      endAt: new Date('2027-01-01Z'),
      status,
      createdBy: actor.actorId,
    },
  });
}
for (const native of [false, true]) {
  test(`full PostgreSQL service semantics native=${native}`, async () => {
    const c = await seed(),
      deps = { client: db.prisma, now, contractReadCandidate: native };
    const view = await updateContract(deps, actor, {
      contractId: c.id,
      ifMatchVersion: 1,
      reason: 'offline parity',
      name: 'after',
      contact: null,
    });
    assert.equal(view.name, 'after');
    assert.equal(view.version, 2);
    assert.isNull(view.contact);
    assert.equal(view.startAt, c.startAt.toISOString());
    await rejects(
      () => updateContract(deps, actor, { contractId: c.id, ifMatchVersion: 1, reason: 'stale' }),
      (error: unknown) => (error as { code?: string }).code === 'VERSION_CONFLICT',
    );
    assert.equal((await db.prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).version, 2);
    assert.equal(
      await db.prisma.auditLog.count({ where: { objectId: c.id, action: 'contract.update', result: 'SUCCESS' } }),
      1,
    );
    assert.equal(
      await db.prisma.auditLog.count({ where: { objectId: c.id, action: 'contract.update', result: 'FAILURE' } }),
      1,
    );
    await rejects(
      () => updateContract(deps, actor, { contractId: 'missing-text', ifMatchVersion: 1, reason: 'missing' }),
      /not found/i,
    );
    const ended = await seed('TERMINATED');
    await rejects(() =>
      updateContract(deps, actor, { contractId: ended.id, ifMatchVersion: 1, reason: 'invalid', name: 'bad' }),
    );
    assert.equal((await db.prisma.contract.findUniqueOrThrow({ where: { id: ended.id } })).version, 1);
    const window = await seed();
    await rejects(() =>
      updateContract(deps, actor, {
        contractId: window.id,
        ifMatchVersion: 1,
        reason: 'invalid window',
        endAt: new Date('2025-01-01Z'),
      }),
    );
    assert.equal((await db.prisma.contract.findUniqueOrThrow({ where: { id: window.id } })).version, 1);
  });
  test(`audit failure rolls back business and preserves original error native=${native}`, async () => {
    const c = await seed(),
      failure = Error('CONTROLLED_AUDIT_FAILURE');
    const client = db.prisma.$extends({
      query: {
        auditLog: {
          create({ args, query }) {
            if (args.data.result === 'SUCCESS') throw failure;
            return query(args);
          },
        },
      },
    });
    await rejects(
      () =>
        updateContract({ client: client as never, now, contractReadCandidate: native }, actor, {
          contractId: c.id,
          ifMatchVersion: 1,
          reason: 'rollback',
          name: 'must rollback',
        }),
      (e) => e === failure,
    );
    const current = await db.prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(current.version, 1);
    assert.equal(current.name, 'before');
    assert.equal(await db.prisma.auditLog.count({ where: { objectId: c.id, result: 'SUCCESS' } }), 0);
    assert.equal(await db.prisma.auditLog.count({ where: { objectId: c.id, result: 'FAILURE' } }), 1);
  });
}
for (const role of [
  'PlatformSuperAdmin',
  'PlatformOperator',
  'Auditor',
  'CustomerAdmin',
  'CustomerViewer',
  'unauthenticated',
])
  test(`candidate handler retains role guard ${role}`, async () => {
    const c = await seed(),
      h = createAdminContractHandlers({ client: db.prisma, now, contractReadCandidate: true });
    const a =
      role === 'unauthenticated'
        ? undefined
        : {
            ...actor,
            roles: [role] as ActorContext['roles'],
            actorType: role.startsWith('Customer') ? ('customer' as const) : ('platform' as const),
            customerId: role.startsWith('Customer') ? customerId : null,
          };
    const response = await h.update({
      actor: a,
      headers: { 'If-Match': '1' },
      requestId: 'offline-role',
      params: { contractId: c.id },
      body: { name: 'role write', reason: 'offline role' },
    });
    const allowed = role === 'PlatformSuperAdmin';
    assert.equal(response.status, allowed ? 200 : role === 'unauthenticated' ? 401 : 403);
    assert.equal((await db.prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).version, allowed ? 2 : 1);
    if (role === 'Auditor') {
      const read = await h.detail({ actor: a, headers: {}, requestId: 'offline-read', params: { contractId: c.id } });
      assert.equal(read.status, 200);
      assert.isNull((read.body as { data: { contact: unknown } }).data.contact);
    }
  });
test('default false delegates once; candidate rejects wrong pool/root before SQL', async () => {
  const findFirst = vi.fn().mockResolvedValue(null),
    query = vi.fn();
  const tx = { contract: { findFirst }, $queryRaw: query };
  assert.isNull(await readContractForUpdate(tx as never, 'text-id'));
  assert.equal(findFirst.mock.calls.length, 1);
  assert.equal(query.mock.calls.length, 0);
  process.env.FDP_DB_POOL_MAX = '2';
  try {
    await rejects(() => readContractForUpdate(tx as never, 'text-id', true), /POOL1_TRANSACTION/);
  } finally {
    process.env.FDP_DB_POOL_MAX = '1';
  }
  await rejects(() => readContractForUpdate({ ...tx, $connect() {} } as never, 'text-id', true), /POOL1_TRANSACTION/);
  assert.equal(query.mock.calls.length, 0);
});
test('native parameter binding, null, malformed rows and driver error have no ORM fallback/retry', async () => {
  const id = "text-id' OR 1=1 --",
    c = await seed();
  const good = { ...c, id };
  for (const value of [
    [],
    [good],
    null,
    [good, good],
    [{ ...good, id: 'other' }],
    [{ ...good, version: 0 }],
    [{ ...good, version: 1.5 }],
    [{ ...good, startAt: 'bad' }],
    [{ ...good, endAt: new Date(NaN) }],
    [{ ...good, contact: 9 }],
    [{ ...good, createdBy: null }],
  ]) {
    const findFirst = vi.fn(),
      query = vi.fn().mockResolvedValue(value),
      tx = { contract: { findFirst }, $queryRaw: query };
    if (Array.isArray(value) && value.length === 0) assert.isNull(await readContractForUpdate(tx as never, id, true));
    else if (value?.[0] === good && value.length === 1)
      assert.strictEqual(await readContractForUpdate(tx as never, id, true), good);
    else await rejects(() => readContractForUpdate(tx as never, id, true), /INVALID_CONTRACT/);
    assert.equal(query.mock.calls.length, 1);
    assert.equal(findFirst.mock.calls.length, 0);
    const [strings, boundId] = query.mock.calls[0]!;
    assert.equal(boundId, id);
    assert.notInclude(strings.join(''), id);
  }
  const error = Error('CONTROLLED_DRIVER_FAILURE'),
    query = vi.fn().mockRejectedValue(error),
    findFirst = vi.fn();
  await rejects(
    () => readContractForUpdate({ $queryRaw: query, contract: { findFirst } } as never, id, true),
    (e) => e === error,
  );
  assert.equal(query.mock.calls.length, 1);
  assert.equal(findFirst.mock.calls.length, 0);
});
