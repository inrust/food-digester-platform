import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createControlledWriter } from '../controlled-writer.js';
import { digest } from '../contracts.js';
import { rootId, operationId } from '../run-ledger.js';
import { context, NOW, provision, request, viewer, writerFixture } from './fixtures.js';
const open: Array<Awaited<ReturnType<typeof writerFixture>>> = [];
async function fixture() {
  const f = await writerFixture();
  open.push(f);
  return f;
}
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

test('real PG operations seed INVITED users, bind provenance, enable and disable using authority epochs', async () => {
  const f = await fixture(),
    d = await provision(f),
    userId = await viewer(f, d.customerId);
  const q = request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 });
  const enabled = await f.invoke(q);
  expect(enabled.status).toBe('COMMITTED');
  expect((await f.prisma.user.findUnique({ where: { id: userId } }))?.status).toBe('ACTIVE');
  expect((await f.prisma.deviceLiveImagePolicy.findUnique({ where: { deviceId: d.deviceId } }))?.enabled).toBe(true);
  const c = await f.control.readControl(d.deviceId);
  expect(c?.enabled).toBe(true);
  expect(c!.authEpoch).toBeGreaterThan(0);
  const receipt = await f.prisma.auditLog.findUnique({ where: { id: operationId(f.bound, q) } });
  expect(receipt?.result).toBe('SUCCESS');
  expect((receipt?.afterValue as any).state).toBe('COMMITTED');
  const disabled = await f.invoke(
    request(f.bound, 'DISABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: c!.authEpoch }),
  );
  expect(disabled.status).toBe('COMMITTED');
  expect((await f.control.readControl(d.deviceId))?.enabled).toBe(false);
});
test('same operation reuses receipt; different content conflicts; same-action different ID cannot reseed', async () => {
  const f = await fixture(),
    q = request(f.bound, 'SEED_PROVISIONER');
  const a = await f.invoke(q),
    b = await f.invoke(q);
  expect(a.status).toBe('COMMITTED');
  expect(b.status).toBe('COMMITTED');
  expect(b.replayed).toBe(true);
  expect(a.result).toEqual(b.result);
  expect((await f.invoke({ ...q, action: 'SEED_VIEWER' })).code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await f.invoke(request(f.bound, 'SEED_PROVISIONER'))).code).toBe('IDENTITY_ALREADY_BOUND');
  expect(await f.prisma.user.count()).toBe(1);
});
test('receipt failure rolls back actual user, roles and run binding in the same PG transaction', async () => {
  const f = await fixture();
  await f.pg.exec(
    "CREATE FUNCTION fail_img21_success() RETURNS trigger AS $$ BEGIN IF NEW.result = 'SUCCESS' AND NEW.object_type = 'IMG21_OPERATION' THEN RAISE EXCEPTION 'injected receipt error'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_receipt BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_img21_success();",
  );
  const q = request(f.bound, 'SEED_PROVISIONER'),
    r = await f.invoke(q);
  expect(r.status).toBe('ROLLED_BACK');
  expect(await f.prisma.user.count()).toBe(0);
  expect(await f.prisma.userRole.count()).toBe(0);
  expect((await f.prisma.auditLog.findUnique({ where: { id: rootId(f.bound) } }))?.afterValue).toMatchObject({
    provisioner: null,
  });
  expect((await f.invoke(q)).status).toBe('ROLLED_BACK');
});
test('SQL policy rollback keeps CONTROL fenced closed and never reports a commit', async () => {
  const f = await fixture(),
    d = await provision(f);
  await viewer(f, d.customerId);
  await f.invoke(request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 }));
  const before = (await f.control.readControl(d.deviceId))!;
  await f.pg.exec(
    "CREATE FUNCTION fail_policy_receipt() RETURNS trigger AS $$ BEGIN IF NEW.result = 'SUCCESS' AND NEW.object_type = 'IMG21_OPERATION' AND NEW.after_value->>'action' = 'DISABLE_PREVIEW' THEN RAISE EXCEPTION 'rollback'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_policy_receipt BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_policy_receipt();",
  );
  const r = await f.invoke(
    request(f.bound, 'DISABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: before.authEpoch }),
  );
  expect(r.status).toBe('ROLLED_BACK');
  expect((await f.prisma.deviceLiveImagePolicy.findUnique({ where: { deviceId: d.deviceId } }))?.enabled).toBe(true);
  const closed = (await f.control.readControl(d.deviceId))!;
  expect(closed.enabled).toBe(false);
  expect(closed.authEpoch).toBeGreaterThan(before.authEpoch);
});
test('post-commit reopen failure preserves SUCCESS receipt and records recovery without replaying mutation', async () => {
  const f = await fixture(),
    d = await provision(f);
  await viewer(f, d.customerId);
  f.control.failReopen = true;
  const q = request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 }),
    r = await f.invoke(q);
  expect(r.status).toBe('SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED');
  expect((await f.prisma.auditLog.findUnique({ where: { id: operationId(f.bound, q) } }))?.result).toBe('SUCCESS');
  expect((await f.prisma.auditLog.findUnique({ where: { id: operationId(f.bound, q) + ':recovery' } }))?.result).toBe(
    'FAILURE',
  );
  const n = f.control.writes.length;
  expect((await f.invoke(q)).status).toBe(r.status);
  expect(f.control.writes.length).toBe(n);
});
test('lost COMMIT acknowledgement returns UNKNOWN; read observes receipt and retry does not create a second user', async () => {
  const f = await fixture(),
    real = f.deps.client;
  let n = 0;
  f.deps.client = new Proxy(real, {
    get(target, key) {
      if (key === '$transaction')
        return async (...args: any[]) => {
          n++;
          const value = await (target.$transaction as any)(...args);
          if (n === 2) throw Error('COMMIT_ACK_LOST');
          return value;
        };
      return Reflect.get(target, key);
    },
  });
  const q = request(f.bound, 'SEED_PROVISIONER');
  expect((await f.invoke(q)).status).toBe('UNKNOWN');
  expect(await f.prisma.user.count()).toBe(1);
  const read = await f.invoke({ ...q, action: 'READ_OPERATION' });
  expect(read.status).toBe('COMMITTED');
  expect(read.result?.status).toBe('INVITED');
  expect((await f.invoke(q)).status).toBe('COMMITTED');
  expect(await f.prisma.user.count()).toBe(1);
});
test('process lost before business transaction leaves durable UNKNOWN intent; repeat never executes it', async () => {
  const f = await fixture(),
    real = f.deps.client;
  let n = 0;
  f.deps.client = new Proxy(real, {
    get(target, key) {
      if (key === '$transaction')
        return async (...args: any[]) => {
          n++;
          if (n === 2) throw Error('PROCESS_LOST_BEFORE_WORK');
          return (target.$transaction as any)(...args);
        };
      return Reflect.get(target, key);
    },
  });
  const q = request(f.bound, 'SEED_PROVISIONER');
  expect((await f.invoke(q)).status).toBe('UNKNOWN');
  expect(await f.prisma.user.count()).toBe(0);
  expect((await f.invoke(q)).status).toBe('UNKNOWN');
  expect(await f.prisma.user.count()).toBe(0);
});
test('concurrent identical operations produce only one PG user and one success receipt', async () => {
  const f = await fixture(),
    q = request(f.bound, 'SEED_PROVISIONER');
  const results = await Promise.all([f.invoke(q), f.invoke(q), f.invoke(q)]);
  expect(results.every((r) => ['COMMITTED', 'UNKNOWN'].includes(r.status))).toBe(true);
  expect(await f.prisma.user.count()).toBe(1);
  expect(await f.prisma.auditLog.count({ where: { id: operationId(f.bound, q), result: 'SUCCESS' } })).toBe(1);
});
for (const [name, mutate] of [
  [
    'disabled provisioner',
    async (f: any, d: any) => f.prisma.user.update({ where: { id: d.adminId }, data: { status: 'DISABLED' } }),
  ],
  ['role revoked', async (f: any, d: any) => f.prisma.userRole.deleteMany({ where: { userId: d.adminId } })],
  [
    'tenant reassignment',
    async (f: any, d: any) => {
      const c = await f.prisma.customer.create({ data: { name: 'foreign' } });
      await f.prisma.device.update({ where: { id: d.deviceId }, data: { customerId: c.id, siteId: null } });
    },
  ],
  [
    'Cognito groups changed',
    async (f: any) => {
      f.identities.provisioner.groups = ['PlatformOperator'];
    },
  ],
  [
    'certificate revoked',
    async (f: any) =>
      f.prisma.deviceCertificate.update({
        where: { id: 'cert-local' },
        data: { status: 'REVOKED', revokedAt: new Date(NOW) },
      }),
  ],
  [
    'device suspended',
    async (f: any, d: any) =>
      f.prisma.device.update({ where: { id: d.deviceId }, data: { lifecycleStatus: 'Suspended' } }),
  ],
  [
    'viewer scope changed',
    async (f: any, d: any, v: string) => {
      const c = await f.prisma.customer.create({ data: { name: 'foreign' } });
      await f.prisma.userScope.updateMany({ where: { userId: v }, data: { customerId: c.id } });
    },
  ],
] as const)
  test(`${name} fails closed before enabling preview`, async () => {
    const f = await fixture(),
      d = await provision(f),
      v = await viewer(f, d.customerId);
    await mutate(f, d, v);
    const r = await f.invoke(request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 }));
    expect(r.status).toBe('ROLLED_BACK');
    expect(await f.prisma.deviceLiveImagePolicy.count()).toBe(0);
    expect(f.control.writes).toEqual([]);
  });
test('stale epoch rejects; another device cannot replace immutable binding', async () => {
  const f = await fixture(),
    d = await provision(f);
  await viewer(f, d.customerId);
  expect(
    (await f.invoke(request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 100 }))).code,
  ).toBe('AUTHORITY_EPOCH_CHANGED');
  expect((await f.invoke(request(f.bound, 'BIND_DEVICE', { deviceId: randomUUID() }))).code).toBe(
    'DEVICE_ALREADY_BOUND',
  );
  expect(
    (await f.invoke(request(f.bound, 'DISABLE_PREVIEW', { deviceId: randomUUID(), expectedAuthEpoch: 0 }))).code,
  ).toBe('OWN_DEVICE_REQUIRED');
});
test('binding needs exact API approval and CSR certificate provenance, not serial prefix alone', async () => {
  const f = await fixture(),
    d = await provision(f, false);
  await f.prisma.auditLog.deleteMany({ where: { objectId: d.customerId, action: 'customer.create' } });
  expect((await f.invoke(request(f.bound, 'BIND_DEVICE', { deviceId: d.deviceId }))).code).toBe(
    'OWN_PROVENANCE_REQUIRED',
  );
  expect((await f.prisma.auditLog.findUnique({ where: { id: rootId(f.bound) } }))?.afterValue).toMatchObject({
    binding: null,
  });
});
test('expired window during Cognito lookup aborts; read-only receipt query remains usable after expiry', async () => {
  const f = await fixture(),
    get = f.deps.identity;
  f.deps.identity = async (name) => {
    const r = await get(name);
    f.setNow(Date.parse(f.bound.manifest.window.endsAt));
    return r;
  };
  const q = request(f.bound, 'SEED_PROVISIONER');
  expect((await f.invoke(q)).status).toBe('ROLLED_BACK');
  expect(await f.prisma.user.count()).toBe(0);
  expect((await f.invoke({ ...q, action: 'READ_OPERATION' })).status).toBe('ROLLED_BACK');
  expect((await f.invoke(request(f.bound, 'SEED_PROVISIONER'))).code).toBe('WINDOW_NOT_OPEN');
});
test('unknown fields and $LATEST are rejected before reserving or writing any PG record', async () => {
  const f = await fixture(),
    q = request(f.bound, 'SEED_PROVISIONER');
  expect((await f.invoke({ ...q, sql: 'select secret' })).status).toBe('REJECTED');
  expect(
    (await createControlledWriter(f.bound, f.deps)(q, { ...context('writer', f.bound), functionVersion: '$LATEST' }))
      .code,
  ).toBe('PUBLISHED_VERSION_REQUIRED');
  expect(await f.prisma.auditLog.count()).toBe(0);
});
test('cleanup refuses foreign actor leases and additional scopes without fencing foreign records', async () => {
  const f = await fixture(),
    d = await provision(f),
    v = await viewer(f, d.customerId);
  f.identities.viewer!.enabled = false;
  await f.prisma.deviceLiveImagePolicy.create({ data: { deviceId: d.deviceId, enabled: false } });
  const foreign = randomUUID();
  await f.prisma.device.create({
    data: {
      id: foreign,
      serialNumber: 'foreign',
      model: 'x',
      hardwareVersion: 'x',
      manufacturer: 'x',
      manufactureDate: new Date(NOW),
      liveImagePolicy: { create: { enabled: true } },
    },
  });
  f.control.values.set(foreign, {
    deviceId: foreign,
    customerId: null,
    enabled: true,
    revision: 1,
    authEpoch: 1,
    streamId: null,
    viewers: [{ actorId: f.identities.viewer!.sub, viewerId: 'old', expiresAtMs: NOW - 1 }],
    latestCapturedAtMs: null,
    lastNewFrameAtMs: null,
  });
  const q = request(f.bound, 'DISABLE_IDENTITY', { userId: v, deviceId: d.deviceId, expectedAuthEpoch: 0 });
  expect((await f.invoke(q)).code).toBe('FOREIGN_OR_EXISTING_ACTOR_LEASE');
  expect(f.control.writes).toEqual([]);
  expect((await f.prisma.user.findUnique({ where: { id: v } }))?.status).toBe('ACTIVE');
});
test('own viewer cleanup after certificate revocation and suspension closes leases without modifying lifecycle', async () => {
  const f = await fixture(),
    d = await provision(f),
    v = await viewer(f, d.customerId);
  await f.invoke(request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 }));
  const old = (await f.control.readControl(d.deviceId))!;
  f.control.values.set(d.deviceId, {
    ...old,
    viewers: [{ actorId: f.identities.viewer!.sub, viewerId: 'own', expiresAtMs: NOW + 5000 }],
  });
  await f.prisma.device.update({ where: { id: d.deviceId }, data: { lifecycleStatus: 'Suspended' } });
  await f.prisma.deviceCertificate.update({
    where: { id: 'cert-local' },
    data: { status: 'REVOKED', revokedAt: new Date(NOW) },
  });
  f.identities.viewer!.enabled = false;
  const r = await f.invoke(
    request(f.bound, 'DISABLE_IDENTITY', { userId: v, deviceId: d.deviceId, expectedAuthEpoch: old.authEpoch }),
  );
  expect(r.status).toBe('COMMITTED');
  expect((await f.control.readControl(d.deviceId))?.viewers).toEqual([]);
  expect((await f.prisma.device.findUnique({ where: { id: d.deviceId } }))?.lifecycleStatus).toBe('Suspended');
});
test('unused owned provisional admin cleanup preserves last-super-admin invariant', async () => {
  const f = await fixture(),
    seed = await f.invoke(request(f.bound, 'SEED_PROVISIONER'));
  f.identities.provisioner!.enabled = false;
  const q = request(f.bound, 'DISABLE_IDENTITY', { userId: String(seed.result!.userId) });
  expect((await f.invoke(q)).code).toBe('LAST_SUPER_ADMIN');
  await f.prisma.user.create({
    data: {
      email: 'existing@example.invalid',
      displayName: 'existing',
      status: 'ACTIVE',
      roles: { create: { roleCode: 'PlatformSuperAdmin' } },
    },
  });
  expect((await f.invoke({ ...q, operationId: digest('cleanup-new-op') })).status).toBe('COMMITTED');
});

test('successful policy receipt contains the pre-write and fenced epoch in the business transaction', async () => {
  const f = await fixture(),
    d = await provision(f);
  await viewer(f, d.customerId);
  const q = request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 }),
    r = await f.invoke(q);
  expect(r.status).toBe('COMMITTED');
  expect(r.result?.beforeAuthEpoch).toBe(0);
  expect(Number(r.result?.fencedAuthEpoch)).toBeGreaterThan(0);
  expect(r.observedAuthEpoch).toBeGreaterThan(Number(r.result?.fencedAuthEpoch));
});
test('replaying an old success after authorization revocation never reopens CONTROL', async () => {
  const f = await fixture(),
    d = await provision(f);
  await viewer(f, d.customerId);
  const q = request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 });
  await f.invoke(q);
  const c = (await f.control.readControl(d.deviceId))!;
  f.control.values.set(d.deviceId, { ...c, enabled: false, authEpoch: c.authEpoch + 1, revision: c.revision + 1 });
  await f.prisma.user.update({ where: { id: d.adminId }, data: { status: 'DISABLED' } });
  const count = f.control.writes.length;
  expect((await f.invoke(q)).status).toBe('SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED');
  expect(f.control.writes.length).toBe(count);
});
test('viewer disable with no retained lease commits without inventing a CONTROL fence or recovery failure', async () => {
  const f = await fixture(),
    d = await provision(f),
    v = await viewer(f, d.customerId);
  f.identities.viewer!.enabled = false;
  const r = await f.invoke(
    request(f.bound, 'DISABLE_IDENTITY', { userId: v, deviceId: d.deviceId, expectedAuthEpoch: 0 }),
  );
  expect(r.status).toBe('COMMITTED');
  expect(r.result?.fenceRequired).toBe(false);
  expect(f.control.writes).toEqual([]);
});
test('a second device in the candidate customer blocks initial binding', async () => {
  const f = await fixture(),
    d = await provision(f, false);
  await f.prisma.device.create({
    data: {
      id: randomUUID(),
      serialNumber: 'second',
      model: 'x',
      hardwareVersion: 'x',
      manufacturer: 'x',
      manufactureDate: new Date(NOW),
      customerId: d.customerId,
    },
  });
  expect((await f.invoke(request(f.bound, 'BIND_DEVICE', { deviceId: d.deviceId }))).code).toBe(
    'ISOLATED_CUSTOMER_REQUIRED',
  );
});
test('DB authority revocation between reservation and work is observed under the next transaction barrier', async () => {
  const f = await fixture(),
    d = await provision(f);
  await viewer(f, d.customerId);
  const real = f.deps.client;
  let n = 0;
  f.deps.client = new Proxy(real, {
    get(target, key) {
      if (key === '$transaction')
        return async (...args: any[]) => {
          n++;
          if (n === 2) await f.prisma.user.update({ where: { id: d.adminId }, data: { status: 'DISABLED' } });
          return (target.$transaction as any)(...args);
        };
      return Reflect.get(target, key);
    },
  });
  const r = await f.invoke(request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 }));
  expect(r.code).toBe('PROVISIONER_NOT_ACTIVE');
  expect(f.control.writes).toEqual([]);
});

test('lost reservation acknowledgement leaves UNKNOWN and cannot start the business write on retry', async () => {
  const f = await fixture(),
    real = f.deps.client;
  let n = 0;
  f.deps.client = new Proxy(real, {
    get(target, key) {
      if (key === '$transaction')
        return async (...args: any[]) => {
          const value = await (target.$transaction as any)(...args);
          if (++n === 1) throw Error('INTENT_ACK_LOST');
          return value;
        };
      return Reflect.get(target, key);
    },
  });
  const q = request(f.bound, 'SEED_PROVISIONER');
  expect((await f.invoke(q)).code).toBe('RESERVATION_OUTCOME_UNKNOWN');
  expect((await f.invoke(q)).status).toBe('UNKNOWN');
  expect(await f.prisma.user.count()).toBe(0);
});
test('rollback receipt write failure retains UNKNOWN instead of promising safe replay', async () => {
  const f = await fixture();
  f.identities.provisioner!.groups = [];
  await f.pg.exec(
    "CREATE FUNCTION reject_terminal_receipt() RETURNS trigger AS $$ BEGIN IF NEW.object_type = 'IMG21_OPERATION' THEN RAISE EXCEPTION 'cannot mark rollback'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER fail_terminal BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_terminal_receipt();",
  );
  const q = request(f.bound, 'SEED_PROVISIONER');
  expect((await f.invoke(q)).code).toBe('ROLLBACK_RECEIPT_UNAVAILABLE');
  expect((await f.invoke(q)).status).toBe('UNKNOWN');
  expect(await f.prisma.user.count()).toBe(0);
});
test('existing Cognito age or DB account cannot be claimed as an isolated newly seeded identity', async () => {
  const f = await fixture();
  f.identities.provisioner!.createdAtMs = Date.parse(f.bound.manifest.window.startsAt) - 1;
  expect((await f.invoke(request(f.bound, 'SEED_PROVISIONER'))).code).toBe('COGNITO_IDENTITY_CHANGED');
  f.identities.provisioner!.createdAtMs = NOW - 1000;
  await f.prisma.user.create({
    data: { email: f.bound.manifest.provisioner.email, displayName: 'old', cognitoSub: f.identities.provisioner!.sub },
  });
  expect((await f.invoke(request(f.bound, 'SEED_PROVISIONER'))).code).toBe('EXISTING_DB_IDENTITY_REJECTED');
});

test('CONTROL read outage after successful reopen preserves committed SQL without falsely claiming closed preview', async () => {
  const f = await fixture(),
    d = await provision(f);
  await viewer(f, d.customerId);
  const read = f.control.readControl.bind(f.control);
  f.control.readControl = async (id: string) => {
    if (f.control.values.get(id)?.enabled) throw Error('OBSERVATION_UNAVAILABLE');
    return read(id);
  };
  const q = request(f.bound, 'ENABLE_PREVIEW', { deviceId: d.deviceId, expectedAuthEpoch: 0 }),
    r = await f.invoke(q);
  expect(r.status).toBe('UNKNOWN');
  expect(r.code).toBe('SQL_COMMITTED_CONTROL_OBSERVATION_UNAVAILABLE');
  expect(f.control.values.get(d.deviceId)?.enabled).toBe(true);
  expect((await f.prisma.auditLog.findUnique({ where: { id: operationId(f.bound, q) } }))?.result).toBe('SUCCESS');
  f.control.readControl = read;
  expect((await f.invoke(request(f.bound, 'READ_OPERATION', { operationId: q.operationId }))).status).toBe('COMMITTED');
});
test('window expiring while successful receipt is awaited rolls business and receipt back together', async () => {
  const f = await fixture(),
    real = f.deps.client;
  let n = 0;
  f.deps.client = new Proxy(real, {
    get(target, key) {
      if (key === '$transaction')
        return async (callback: any, options: any) => {
          n++;
          return target.$transaction(async (tx: any) => {
            if (n !== 2) return callback(tx);
            const wrapped = new Proxy(tx, {
              get(obj, field) {
                if (field === 'auditLog')
                  return new Proxy(obj.auditLog, {
                    get(delegate, method) {
                      if (method === 'update')
                        return async (args: any) => {
                          const value = await delegate.update(args);
                          if (args.data.afterValue?.state === 'COMMITTED')
                            f.setNow(Date.parse(f.bound.manifest.window.endsAt));
                          return value;
                        };
                      return Reflect.get(delegate, method);
                    },
                  });
                return Reflect.get(obj, field);
              },
            });
            return callback(wrapped);
          }, options);
        };
      return Reflect.get(target, key);
    },
  });
  const q = request(f.bound, 'SEED_PROVISIONER'),
    r = await f.invoke(q);
  expect(r.status).toBe('ROLLED_BACK');
  expect(r.code).toBe('WINDOW_NOT_OPEN');
  expect(await f.prisma.user.count()).toBe(0);
  expect((await f.prisma.auditLog.findUnique({ where: { id: operationId(f.bound, q) } }))?.result).toBe('FAILURE');
});
