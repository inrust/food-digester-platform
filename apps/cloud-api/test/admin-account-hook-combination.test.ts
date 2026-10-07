import { afterAll, beforeAll, describe, test, assert, vi } from 'vitest';
import { rejects } from 'node:assert/strict';
import type { ActorContext } from '@fdp/auth';
import { AuthenticatedPreconnect } from '../../../packages/database/src/authenticated-preconnect.js';
import { createAuthenticatedEngineDiagnostic } from '../src/runtime/admin-engine-diagnostic.js';
import { createAdminAuthenticatedAccountHook } from '../src/runtime/admin-account-hook.js';
import { createTestDb } from './helpers.js';

describe.each([false, true])(
  'real PGlite account hook C1=%s (checkout port controlled, not real pg network)',
  (enabled) => {
    let db: Awaited<ReturnType<typeof createTestDb>>;
    beforeAll(async () => {
      db = await createTestDb();
    }, 60000);
    afterAll(async () => {
      await db.prisma.$disconnect();
      await db.pg.close();
    });
    let seq = 0;
    const actor = (sub: string): ActorContext => ({
      actorId: sub,
      username: sub,
      actorType: 'platform',
      roles: ['Auditor'],
      customerId: null,
      tokenUse: 'access',
    });
    const plant = async (status: string) => {
      const sub = `combine-${enabled}-${++seq}`;
      const row = await db.prisma.user.create({
        data: { cognitoSub: sub, email: `${sub}@example.com`, displayName: sub, status },
      });
      return { ...row, cognitoSub: sub };
    };
    function setup(checkout: () => Promise<void> = async () => {}) {
      const pool = { prepareAuthenticatedConnection: vi.fn(checkout) },
        ownership = new AuthenticatedPreconnect();
      const prepare = enabled
        ? () =>
            ownership.prepare(async () => {
              ownership.adapterReady(pool);
              await db.prisma.$connect();
            })
        : createAuthenticatedEngineDiagnostic(true, db.prisma);
      return { hook: createAdminAuthenticatedAccountHook(db.prisma, prepare, true), pool };
    }
    test('successful preparation never caches ACTIVE status: later DISABLED is rejected', async () => {
      const u = await plant('ACTIVE'),
        { hook, pool } = setup();
      await hook(actor(u.cognitoSub), 'active');
      await db.prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
      await rejects(hook(actor(u.cognitoSub), 'disabled'), (e) => (e as { code: string }).code === 'UNAUTHENTICATED');
      assert.equal(pool.prepareAuthenticatedConnection.mock.calls.length, enabled ? 1 : 0);
      assert.equal(await db.prisma.auditLog.count({ where: { objectId: u.id } }), 0);
    });
    test('INVITED activation and audit remain atomic and repeated requests are idempotent', async () => {
      const u = await plant('INVITED'),
        { hook } = setup();
      await hook(actor(u.cognitoSub), 'activation');
      await hook(actor(u.cognitoSub), 'repeat');
      assert.equal((await db.prisma.user.findUnique({ where: { id: u.id } }))?.status, 'ACTIVE');
      const audits = await db.prisma.auditLog.findMany({ where: { objectId: u.id, action: 'user.activate' } });
      assert.equal(audits.length, 1);
      assert.equal(audits[0].requestId, 'activation');
    });
    test('INVITED disabled after first read cannot activate or audit', async () => {
      const u = await plant('INVITED'),
        { hook } = setup(),
        find = db.prisma.user.findFirst.bind(db.prisma.user);
      const query = vi.spyOn(db.prisma.user, 'findFirst').mockImplementationOnce(
        (args) =>
          (async () => {
            const row = await find(args);
            await db.prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
            return row;
          })() as ReturnType<typeof db.prisma.user.findFirst>,
      );
      try {
        await rejects(hook(actor(u.cognitoSub), 'race'));
        assert.equal((await db.prisma.user.findUnique({ where: { id: u.id } }))?.status, 'DISABLED');
        assert.equal(await db.prisma.auditLog.count({ where: { objectId: u.id } }), 0);
      } finally {
        query.mockRestore();
      }
    });
    test('audit write failure rolls back activation in real database transaction', async () => {
      const u = await plant('INVITED'),
        { hook } = setup();
      await db.pg.exec(
        "CREATE FUNCTION qa09_reject_activation() RETURNS trigger AS $$ BEGIN IF NEW.action = 'user.activate' THEN RAISE EXCEPTION 'controlled audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER qa09_reject_activation BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa09_reject_activation();",
      );
      try {
        await rejects(hook(actor(u.cognitoSub), 'rollback'));
        assert.equal((await db.prisma.user.findUnique({ where: { id: u.id } }))?.status, 'INVITED');
        assert.equal(await db.prisma.auditLog.count({ where: { objectId: u.id } }), 0);
      } finally {
        await db.pg.exec('DROP TRIGGER qa09_reject_activation ON audit_logs; DROP FUNCTION qa09_reject_activation();');
      }
    });
    test('missing account retains existing no-write behavior', async () => {
      const { hook } = setup();
      await hook(actor('absent'), 'missing');
      assert.equal(await db.prisma.user.count({ where: { cognitoSub: 'absent' } }), 0);
    });
    if (enabled)
      test('checkout failure prevents all account queries; pending checkout delays them', async () => {
        const original = Error('controlled checkout failure'),
          query = vi.spyOn(db.prisma.user, 'findFirst');
        try {
          await rejects(
            setup(async () => {
              throw original;
            }).hook(actor('absent'), 'failed'),
            (e) => e === original,
          );
          assert.equal(query.mock.calls.length, 0);
          let release!: () => void;
          const { hook } = setup(
            () =>
              new Promise<void>((r) => {
                release = r;
              }),
          );
          const pending = hook(actor('absent'), 'pending');
          await new Promise((r) => setImmediate(r));
          assert.equal(query.mock.calls.length, 0);
          release();
          await pending;
          assert.equal(query.mock.calls.length, 1);
        } finally {
          query.mockRestore();
        }
      });
  },
);
