import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAction, receiptDecision, verifyWithPort } from './reference-guards.mjs';
import { signLicensePayload } from '../../../../../apps/cloud-api/src/admin/license/service.ts';
import { withLiveImageAuthority } from '../../../../../packages/aws-clients/src/live-image-authority.ts';
import { createTestDb } from '../../../../../apps/cloud-api/test/helpers.ts';
const now = Date.parse('2026-11-08T12:00:00Z');
const id = '11111111-2222-4333-8444-555555555555',
  cid = '22222222-2222-4333-8444-555555555555';
const hash = 'a'.repeat(64);
function fixture() {
  const spec = {
    runId: 'IMG21-LOCAL-REFERENCE',
    manifestHash: hash,
    serialNumber: 'img21-22d71f6bcb59dee6',
    model: 'IMG21-SIMULATOR',
    customerName: 'IMG21 local',
    target: { accountId: '065986019555', region: 'ap-southeast-1', stackName: 'fdp-test-app' },
    window: {
      approved: true,
      startsAt: new Date(now - 1000).toISOString(),
      endsAt: new Date(now + 60000).toISOString(),
    },
    provisioner: { username: 'run-provisioner@example.invalid', role: 'PlatformSuperAdmin' },
    viewer: { username: 'run-viewer@example.invalid', role: 'CustomerViewer' },
    binding: { deviceId: id, customerId: cid, certificateFingerprint: hash },
    boundUserIds: ['own-viewer'],
  };
  const req = {
    runId: spec.runId,
    manifestHash: hash,
    operationId: 'b'.repeat(64),
    action: 'ENABLE_PREVIEW',
    deviceId: id,
    expectedAuthEpoch: 4,
  };
  const facts = {
    authorityWrapperInstalled: true,
    controlTable: 'fdp-test-live-image-control',
    payloadTable: 'fdp-test-live-image-payload',
    deviceId: id,
    customerId: cid,
    serialNumber: spec.serialNumber,
    otherDeviceCount: 0,
    authEpoch: 4,
    lifecycleStatus: 'Active',
    operationalStatus: 'Active',
    certificateFingerprint: hash,
    certificateCurrent: true,
  };
  const payload = {
    licenseId: '33333333-2222-4333-8444-555555555555',
    deviceId: id,
    customerId: cid,
    validFrom: new Date(now - 1000).toISOString(),
    validTo: new Date(now + 60000).toISOString(),
    entitlements: ['ESG_REPORTING'],
  };
  const secret = Buffer.alloc(64, 7);
  const input = {
    runId: spec.runId,
    manifestHash: hash,
    serialNumber: spec.serialNumber,
    model: spec.model,
    deviceId: id,
    customerId: cid,
    certificateFingerprint: hash,
    snapshotEtag: 'c'.repeat(64),
    nonce: 'd'.repeat(64),
    expiresAtMs: now + 30000,
    license: {
      licenseId: payload.licenseId,
      version: 1,
      status: 'ISSUED',
      effective: true,
      entitlements: payload.entitlements,
      signaturePayload: payload,
      signature: signLicensePayload(secret.toString('utf8'), {
        ...payload,
        validFrom: new Date(payload.validFrom),
        validTo: new Date(payload.validTo),
      }),
    },
  };
  return { spec, req, facts, input, secret };
}
test('eligible owned device passes local contract only', () => {
  const f = fixture();
  assert.deepEqual(validateAction(f.spec, f.req, f.facts, now), {
    status: 'PASS_LOCAL_CONTRACT_ONLY',
    executable: false,
  });
});
for (const [name, change] of [
  ['foreign device', (f) => (f.req.deviceId = 'foreign')],
  ['foreign tenant', (f) => (f.facts.customerId = 'foreign')],
  ['wrong serial', (f) => (f.facts.serialNumber = 'foreign')],
  ['extra device', (f) => (f.facts.otherDeviceCount = 1)],
  ['stale authority', (f) => (f.facts.authEpoch = 5)],
  ['unlicensed device', (f) => (f.facts.lifecycleStatus = 'Assigned')],
  ['revoked certificate', (f) => (f.facts.certificateCurrent = false)],
  ['missing wrapper', (f) => (f.facts.authorityWrapperInstalled = false)],
  ['missing table environment', (f) => (f.facts.payloadTable = null)],
  ['arbitrary SQL input', (f) => (f.req.sql = 'SELECT 1')],
  ['unknown operation', (f) => (f.req.action = 'SET_ACTIVE')],
  ['expired window', (f) => (f.spec.window.endsAt = new Date(now).toISOString())],
  ['approval absent', (f) => (f.spec.window.approved = false)],
  ['overlong window', (f) => (f.spec.window.endsAt = new Date(now + 7200000).toISOString())],
  ['wrong account', (f) => (f.spec.target.accountId = '000000000000')],
])
  test(`writer reference rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => validateAction(f.spec, f.req, f.facts, now));
  });
test('new manifest-owned actor only; existing actor leases cannot be silently ignored', () => {
  const f = fixture();
  f.req.action = 'SEED_PROVISIONER';
  f.facts.cognito = { ...f.spec.provisioner, freshlyCreatedForRun: true };
  f.facts.existingActorLeaseCount = 0;
  assert.equal(validateAction(f.spec, f.req, f.facts, now).executable, false);
  f.facts.existingActorLeaseCount = 1;
  assert.throws(() => validateAction(f.spec, f.req, f.facts, now));
});
test('one-time device binding is immutable and requires trusted database ownership facts', () => {
  const f = fixture();
  f.req.action = 'BIND_DEVICE';
  f.spec.binding = null;
  Object.assign(f.facts, { serverCreatedForRun: true, customerName: f.spec.customerName });
  assert.equal(validateAction(f.spec, f.req, f.facts, now).executable, false);
  f.spec.binding = { deviceId: id };
  assert.throws(() => validateAction(f.spec, f.req, f.facts, now));
});
test('unknown and post-commit recovery failures never become blind retries or claimed rollback', () => {
  assert.equal(receiptDecision(null, hash), 'MAY_ATTEMPT_ONCE_AFTER_ALL_GUARDS');
  assert.equal(receiptDecision({ requestHash: hash, state: 'UNKNOWN' }, hash), 'QUERY_AND_RECONCILE_DO_NOT_RETRY');
  assert.equal(
    receiptDecision({ requestHash: hash, state: 'SQL_COMMITTED_RECOVERY_FAILED' }, hash),
    'SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED',
  );
  assert.equal(receiptDecision({ requestHash: hash, state: 'COMMITTED' }, hash), 'REUSE_COMMITTED_RECEIPT');
  assert.throws(() => receiptDecision({ requestHash: 'b'.repeat(64), state: 'COMMITTED' }, hash));
});
test('local HMAC reference agrees with actual cloud signer for approved img21 binding and clears Buffer', async () => {
  const f = fixture();
  const result = await verifyWithPort(f.spec, f.input, { now: () => now, loadSecret: async () => f.secret });
  assert.equal(result.status, 'PASS_LOCAL_REFERENCE_SIGNATURE');
  assert.equal(result.keyExported, false);
  assert.equal(result.targetExecuted, false);
  assert.equal(result.certificateFingerprint, hash);
  assert.ok(f.secret.every((v) => v === 0));
  assert.ok(!JSON.stringify(result).includes(f.input.license.signature));
});
for (const [name, change] of [
  ['foreign certificate', (f) => (f.input.certificateFingerprint = 'e'.repeat(64))],
  ['foreign tenant', (f) => (f.input.customerId = 'foreign')],
  ['old prefix rewrite', (f) => (f.input.serialNumber = 'syncprobe-22d71f6bcb59dee6')],
  ['wrong model', (f) => (f.input.model = 'other')],
  ['unknown binding', (f) => (f.spec.binding = null)],
  ['expired nonce', (f) => (f.input.expiresAtMs = now)],
  ['overlong TTL', (f) => (f.input.expiresAtMs = now + 300001)],
  ['receipt beyond approved window', (f) => (f.spec.window.endsAt = new Date(now + 10000).toISOString())],
  ['wrong manifest', (f) => (f.input.manifestHash = 'f'.repeat(64))],
  ['wrong payload device', (f) => (f.input.license.signaturePayload.deviceId = 'foreign')],
  ['invalid version', (f) => (f.input.license.version = 0)],
  ['duplicate entitlement', (f) => f.input.license.signaturePayload.entitlements.push('ESG_REPORTING')],
  ['non-UTC instant', (f) => (f.input.license.signaturePayload.validTo = '2026-11-09')],
])
  test(`invalid verifier binding ${name} is rejected before key access`, async () => {
    const f = fixture();
    change(f);
    let calls = 0;
    await assert.rejects(
      verifyWithPort(f.spec, f.input, {
        now: () => now,
        loadSecret: async () => {
          calls++;
          return f.secret;
        },
      }),
    );
    assert.equal(calls, 0);
  });
test('wrong key and response arriving after expiry are rejected and cleared', async () => {
  for (const late of [false, true]) {
    const f = fixture();
    if (!late) f.secret.fill(8);
    let tick = 0;
    await assert.rejects(
      verifyWithPort(f.spec, f.input, {
        now: () => (late && tick++ ? now + 60000 : now),
        loadSecret: async () => f.secret,
      }),
    );
    assert.ok(f.secret.every((v) => v === 0));
  }
});
test('own unused provisional identity can be disabled before a device exists, while foreign leases stop cleanup', () => {
  const f = fixture();
  f.spec.binding = null;
  f.req.action = 'DISABLE_IDENTITY';
  f.req.userId = 'own-viewer';
  Object.assign(f.facts, { ownedIdentityValidated: true, ownedActorLeaseCount: 0, foreignActorLeaseCount: 0 });
  assert.equal(validateAction(f.spec, f.req, f.facts, now).executable, false);
  f.facts.foreignActorLeaseCount = 1;
  assert.throws(() => validateAction(f.spec, f.req, f.facts, now));
});
test('wire signature agrees with cloud signer across entitlement mapping, independent of display order', async () => {
  const f = fixture();
  const payload = f.input.license.signaturePayload;
  payload.entitlements = ['ESG_REPORTING', 'OTA', 'REMOTE_CONTROL'];
  f.input.license.entitlements = ['REMOTE_CONTROL', 'ESG_REPORTING', 'OTA'];
  f.input.license.signature = signLicensePayload(f.secret.toString('utf8'), {
    ...payload,
    validFrom: new Date(payload.validFrom),
    validTo: new Date(payload.validTo),
    entitlements: ['REMOTE_CONTROL', 'OTA_UPDATE', 'ESG_REPORTING'],
  });
  const result = await verifyWithPort(f.spec, f.input, { now: () => now, loadSecret: async () => f.secret });
  assert.equal(result.keyExported, false);
});
test('actual PGlite authority wrapper reads all policy CONTROL metadata for a fresh user, without writing foreign devices', async () => {
  const db = await createTestDb();
  try {
    await db.pg.exec(
      readFileSync(new URL('../../../../../packages/database/prisma/seed.sql', import.meta.url), 'utf8'),
    );
    await db.prisma.customer.createMany({
      data: [
        { id: 'own-customer', name: 'Own' },
        { id: 'foreign-customer', name: 'Foreign' },
      ],
    });
    for (const device of ['own-camera', 'foreign-camera'])
      await db.prisma.device.create({
        data: {
          id: device,
          serialNumber: device,
          customerId: device === 'own-camera' ? 'own-customer' : 'foreign-customer',
          model: 'test',
          hardwareVersion: '1',
          manufacturer: 'test',
          manufactureDate: new Date(now),
          liveImagePolicy: { create: { enabled: true } },
        },
      });
    const reads = [],
      writes = [];
    const client = withLiveImageAuthority(db.prisma, {
      readControl: async (device) => {
        reads.push(device);
        return null;
      },
      compareAndSwap: async (device) => {
        writes.push(device);
        throw Error('UNEXPECTED_WRITE');
      },
    });
    await client.user.create({
      data: {
        id: 'new-own-user',
        email: 'own@example.invalid',
        displayName: 'local',
        cognitoSub: 'new-owned-sub',
        status: 'INVITED',
        roles: { create: { roleCode: 'PlatformSuperAdmin' } },
      },
    });
    assert.deepEqual(new Set(reads), new Set(['own-camera', 'foreign-camera']));
    assert.deepEqual(writes, []);
  } finally {
    await db.prisma.$disconnect();
    await db.pg.close();
  }
});
