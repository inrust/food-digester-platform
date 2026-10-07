import { afterAll, beforeAll, describe, test, assert, vi } from 'vitest';
import { rejects } from 'node:assert/strict';
import type { ActorContext, Role } from '@fdp/auth';
import { activateInvitedUserOnAuthenticatedRequest } from '../src/admin/user/service.js';
import { readAuthenticatedAccount } from '../src/admin/user/account-read-candidate.js';
import { createTestDb } from './helpers.js';

describe.each([false, true])('offline real database account read candidate=%s', (candidate) => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60000);
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pg.close();
  });
  let seq = 0;
  const actor = (sub: string, role: Role = 'Auditor'): ActorContext => ({
    actorId: sub,
    username: sub,
    actorType: role.startsWith('Customer') ? 'customer' : 'platform',
    roles: [role],
    customerId: null,
    tokenUse: 'access',
  });
  const plant = async (status: string) => {
    const sub = `orm-candidate-${candidate}-${++seq}`;
    return db.prisma.user.create({ data: { cognitoSub: sub, email: `${sub}@example.com`, displayName: sub, status } });
  };
  const hook = (sub: string, role?: Role) =>
    activateInvitedUserOnAuthenticatedRequest(
      { client: db.prisma, accountReadCandidate: candidate },
      actor(sub, role),
      `candidate-${seq}`,
    );
  test.each(['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'] as Role[])(
    'fresh state and invitation semantics for %s',
    async (role) => {
      const u = await plant('ACTIVE');
      assert.equal(await hook(u.cognitoSub!, role), false);
      await db.prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
      await rejects(hook(u.cognitoSub!, role), (e) => (e as { code: string }).code === 'UNAUTHENTICATED');
      assert.equal(await hook(`missing-${u.id}`, role), false);
      const invited = await plant('INVITED');
      assert.equal(await hook(invited.cognitoSub!, role), true);
      assert.equal(await hook(invited.cognitoSub!, role), false);
      assert.equal(await db.prisma.auditLog.count({ where: { objectId: invited.id, action: 'user.activate' } }), 1);
    },
  );
  test('parameterized apostrophes cannot select another account; errors never fall back or retry', async () => {
    const u = await plant('ACTIVE');
    assert.equal(await readAuthenticatedAccount(db.prisma, "' OR true --", candidate), null);
    const fail = Error('PRIVATE_DATABASE_ERROR');
    const spy = candidate
      ? vi.spyOn(db.prisma, '$queryRaw').mockRejectedValueOnce(fail)
      : vi.spyOn(db.prisma.user, 'findFirst').mockRejectedValueOnce(fail);
    try {
      await rejects(hook(u.cognitoSub!), (e) => e === fail);
      assert.equal(spy.mock.calls.length, 1);
    } finally {
      spy.mockRestore();
    }
  });
  test('disable between initial read and activation cannot activate or audit', async () => {
    const u = await plant('INVITED');
    const port = (candidate ? db.prisma : db.prisma.user) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const method = candidate ? '$queryRaw' : 'findFirst';
    const read = port[method]!;
    const spy = vi.spyOn(port, method).mockImplementationOnce(async (...args) => {
      const value = await read.apply(port, args);
      await db.prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
      return value;
    });
    try {
      await rejects(hook(u.cognitoSub!), (e) => (e as { code: string }).code === 'UNAUTHENTICATED');
      assert.equal((await db.prisma.user.findUnique({ where: { id: u.id } }))?.status, 'DISABLED');
      assert.equal(await db.prisma.auditLog.count({ where: { objectId: u.id } }), 0);
    } finally {
      spy.mockRestore();
    }
  });
  test('activation audit failure rolls back status', async () => {
    const u = await plant('INVITED');
    await db.pg.exec(
      "CREATE FUNCTION qa09_candidate_fail() RETURNS trigger AS $$ BEGIN IF NEW.action = 'user.activate' THEN RAISE EXCEPTION 'controlled failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER qa09_candidate_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa09_candidate_fail();",
    );
    try {
      await rejects(hook(u.cognitoSub!));
      assert.equal((await db.prisma.user.findUnique({ where: { id: u.id } }))?.status, 'INVITED');
      assert.equal(await db.prisma.auditLog.count({ where: { objectId: u.id } }), 0);
    } finally {
      await db.pg.exec('DROP TRIGGER qa09_candidate_fail ON audit_logs; DROP FUNCTION qa09_candidate_fail();');
    }
  });
});
test('default candidate stays off, and missing/raw failures preserve normal ownership', async () => {
  const orm = vi.fn(async () => null),
    raw = vi.fn(async () => []);
  const client = { user: { findFirst: orm }, $queryRaw: raw } as never;
  assert.equal(await readAuthenticatedAccount(client, 'sub'), null);
  assert.equal(orm.mock.calls.length, 1);
  assert.equal(raw.mock.calls.length, 0);
});
