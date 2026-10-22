import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, generateKeyPairSync, sign, constants } from 'node:crypto';
import { signLicensePayload } from '../apps/cloud-api/src/admin/license/service.ts';
import {
  controlledLicenseVerification,
  verifyDeviceLicense,
  TEST_LICENSE_SECRET_ARN,
} from './qa09-device-license-verifier.mjs';
import { prepareFirmwareFixture, signFirmwareFixture, TEST_OTA_KEY_ARN } from './qa09-firmware-fixture.mjs';
import { verifyLicenseEvent } from './license-hmac-verifier-entry.mjs';
const now = Date.parse('2026-10-13T10:00:00.000Z'),
  key = randomBytes(32).toString('hex');
function licenseInput() {
  const p = {
    licenseId: randomUUID(),
    deviceId: 'qa09-1234567890abcdef-01',
    customerId: randomUUID(),
    validFrom: new Date(now - 1000),
    validTo: new Date(now + 3600000),
    entitlements: ['OTA_UPDATE', 'REMOTE_CONTROL'],
  };
  return {
    prefix: 'qa09-1234567890abcdef',
    deviceId: p.deviceId,
    customerId: p.customerId,
    applicationCommit: 'a'.repeat(40),
    snapshotEtag: 'b'.repeat(64),
    certificateFingerprint: 'c'.repeat(64),
    nonce: 'd'.repeat(32),
    expiresAtMs: now + 60000,
    license: {
      licenseId: p.licenseId,
      status: 'ACTIVE',
      version: 1,
      effective: true,
      entitlements: ['OTA', 'REMOTE_CONTROL'],
      signature: signLicensePayload(key, p),
      signaturePayload: {
        ...p,
        validFrom: p.validFrom.toISOString(),
        validTo: p.validTo.toISOString(),
        entitlements: ['OTA', 'REMOTE_CONTROL'],
      },
    },
  };
}
function csrLicenseInput() {
  const input = licenseInput();
  input.prefix = 'syncprobe-1234567890abcdef';
  input.deviceId = randomUUID();
  input.license.signaturePayload.deviceId = input.deviceId;
  const p = input.license.signaturePayload;
  input.license.signature = signLicensePayload(key, {
    ...p,
    validFrom: new Date(p.validFrom),
    validTo: new Date(p.validTo),
  });
  input.deviceBinding = {
    serialNumber: input.prefix,
    model: 'SYNC-1234567890ABCDEF',
    deviceId: input.deviceId,
    certificateFingerprint: input.certificateFingerprint,
  };
  return input;
}

test('real CSR UUID scope requires exact serial/model/device/certificate binding and stable binding digest', () => {
  const input = csrLicenseInput();
  const proof = verifyDeviceLicense(input, key, now);
  assert.equal(proof.deviceId, input.deviceId);
  assert.match(proof.deviceBindingSha256, /^[a-f0-9]{64}$/);
  const reordered = { ...input, deviceBinding: Object.fromEntries(Object.entries(input.deviceBinding).reverse()) };
  assert.equal(verifyDeviceLicense(reordered, key, now).deviceBindingSha256, proof.deviceBindingSha256);
});

test('CSR UUID scope rejects foreign or missing bindings before accessing any key', async () => {
  for (const mutate of [
    (x) => delete x.deviceBinding,
    (x) => (x.deviceBinding.serialNumber = 'syncprobe-ffffffffffffffff'),
    (x) => (x.deviceBinding.model = 'BNX-100'),
    (x) => (x.deviceBinding.deviceId = randomUUID()),
    (x) => (x.deviceBinding.certificateFingerprint = 'e'.repeat(64)),
    (x) => (x.deviceBinding.extra = true),
    (x) => (x.prefix = 'outside'),
    (x) => (x.deviceId = 'unbound'),
  ]) {
    const input = csrLicenseInput();
    mutate(input);
    let reads = 0;
    await assert.rejects(
      controlledLicenseVerification(input, {
        now: () => now,
        loadSecret: async () => {
          reads++;
          return { arn: TEST_LICENSE_SECRET_ARN, value: key, versionId: 'test' };
        },
      }),
    );
    assert.equal(reads, 0);
  }
});

test('License-only entry pins application source and dedicated role; never routes firmware signing', async () => {
  const { a2SourceHashes } = await import('./qa09-a2-controlled-worker.mjs');
  const input = { ...csrLicenseInput(), operation: 'LICENSE_VERIFY', sourceHashes: a2SourceHashes() };
  let reads = 0;
  const ports = {
    applicationCommit: input.applicationCommit,
    now: () => now,
    identity: async () => ({
      Account: '065986019555',
      Arn: 'arn:aws:sts::065986019555:assumed-role/fdp-test-qa09-license-verifier-role/test',
    }),
    loadSecret: async () => {
      reads++;
      return { arn: TEST_LICENSE_SECRET_ARN, value: key, versionId: 'unit-only-version' };
    },
  };
  const result = await verifyLicenseEvent(input, ports);
  assert.equal(result.gate, 'PASS_INDEPENDENT_SIMULATED_DEVICE_LICENSE_SIGNATURE');
  assert.equal(result.operation, 'LICENSE_VERIFY');
  assert.equal(reads, 1);
  assert(!JSON.stringify(result).includes(key));
  for (const invalid of [
    { ...input, operation: 'FIRMWARE_SIGN' },
    { ...input, applicationCommit: 'f'.repeat(40) },
    { ...input, sourceHashes: {} },
    { ...input, padding: 'x'.repeat(16384) },
  ])
    await assert.rejects(verifyLicenseEvent(invalid, ports));
  await assert.rejects(
    verifyLicenseEvent(input, {
      ...ports,
      identity: async () => ({
        Account: '065986019555',
        Arn: 'arn:aws:sts::065986019555:assumed-role/fdp-test-api-role/test',
      }),
    }),
  );
  assert.equal(reads, 1);
});
test('independent verifier accepts actual cloud signer wire values and exports only bounded hashes', async () => {
  const input = licenseInput();
  let reads = 0;
  const result = await controlledLicenseVerification(input, {
    now: () => now,
    loadSecret: async (arn) => {
      reads++;
      assert.equal(arn, TEST_LICENSE_SECRET_ARN);
      return { arn, value: key, versionId: 'current-version' };
    },
  });
  assert.equal(result.gate, 'PASS_INDEPENDENT_SIMULATED_DEVICE_LICENSE_SIGNATURE');
  assert.equal(reads, 1);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!JSON.stringify(result).includes(input.license.signature));
  assert.equal(result.physicalDeviceAttested, false);
});
test('foreign/stale/expired/revoked/date-only/extra fields and signature drift fail before VERIFIED', () => {
  for (const mutate of [
    (x) => (x.deviceId = 'foreign'),
    (x) => (x.expiresAtMs = now),
    (x) => (x.license.effective = false),
    (x) => (x.license.status = 'REVOKED'),
    (x) => (x.license.signaturePayload.validFrom = '2026-10-13'),
    (x) => (x.license.signaturePayload.extra = 'field'),
    (x) => (x.license.signaturePayload.customerId = randomUUID()),
    (x) => (x.license.signature = 'v1.' + 'A'.repeat(43)),
  ]) {
    const x = licenseInput();
    mutate(x);
    assert.throws(() => verifyDeviceLicense(x, key, now));
  }
});
test('invalid owned input never fetches a secret; wrong secret binding is rejected', async () => {
  let reads = 0;
  const x = licenseInput();
  x.deviceId = 'outside';
  await assert.rejects(
    controlledLicenseVerification(x, {
      now: () => now,
      loadSecret: async () => {
        reads++;
      },
    }),
  );
  assert.equal(reads, 0);
  await assert.rejects(
    controlledLicenseVerification(licenseInput(), {
      now: () => now,
      loadSecret: async () => ({ arn: 'foreign', value: key, versionId: 'v' }),
    }),
  );
});
test('firmware fixture is non-executable and requires the bound KMS key, RSA signature and exact bytes', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const f = prepareFirmwareFixture('qa09-1234567890abcdef');
  const signer = async (input) => ({
    KeyId: TEST_OTA_KEY_ARN,
    SigningAlgorithm: input.SigningAlgorithm,
    Signature: sign('RSA-SHA256', input.Message, { key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING }),
  });
  const result = await signFirmwareFixture(f, { sign: signer, publicKey: pair.publicKey });
  assert.equal(result.physicalExecutable, false);
  assert.equal(result.scope, 'CLOUD_OTA_PROTOCOL_ONLY_NOT_FLASHABLE');
  await assert.rejects(
    signFirmwareFixture(
      { ...f, fields: { ...f.fields, version: 'changed' } },
      { sign: signer, publicKey: pair.publicKey },
    ),
  );
  await assert.rejects(
    signFirmwareFixture({ ...f, bytes: Buffer.from('changed') }, { sign: signer, publicKey: pair.publicKey }),
  );
  await assert.rejects(
    signFirmwareFixture(f, {
      sign: async (input) => ({ ...(await signer(input)), KeyId: 'foreign' }),
      publicKey: pair.publicKey,
    }),
  );
});

test('controlled worker binds frozen sources, dedicated test role and current input before key access', async () => {
  const { runControlledA2, a2SourceHashes } = await import('./qa09-a2-controlled-worker.mjs');
  let reads = 0;
  const ports = {
    now: () => now,
    identity: async () => ({
      Account: '065986019555',
      Arn: 'arn:aws:sts::065986019555:assumed-role/fdp-test-qa09-license-verifier-role/test',
    }),
    loadSecret: async (arn) => {
      reads++;
      return { arn, value: key, versionId: 'test-version' };
    },
  };
  const input = { ...licenseInput(), operation: 'LICENSE_VERIFY', sourceHashes: a2SourceHashes() };
  assert.equal((await runControlledA2(input, ports)).operation, 'LICENSE_VERIFY');
  assert.equal(reads, 1);
  await assert.rejects(runControlledA2({ ...input, sourceHashes: {} }, ports), /BOUND_CURRENT/);
  await assert.rejects(
    runControlledA2(input, {
      ...ports,
      identity: async () => ({
        Account: '065986019555',
        Arn: 'arn:aws:sts::065986019555:assumed-role/fdp-test-migration-runner-role/test',
      }),
    }),
    /DEDICATED/,
  );
  assert.equal(reads, 1);
});
