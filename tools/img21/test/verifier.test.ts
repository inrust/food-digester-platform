import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createLicenseVerifier } from '../license-verifier.js';
import type { LicenseInput, SecretMaterial } from '../license-verifier.js';
import { createSecretPort } from '../secret-port.js';
import { createIdentityPort } from '../identity-port.js';
import { bindManifest, digest, TARGET } from '../contracts.js';
import { signLicensePayload } from '../../../apps/cloud-api/src/admin/license/service.js';
import { manifest, context, NOW, cert } from './fixtures.js';
function fixture() {
  const licenseId = randomUUID(),
    deviceId = randomUUID(),
    customerId = randomUUID(),
    siteId = randomUUID();
  const bound = manifest({
    verifierBinding: {
      deviceId,
      customerId,
      siteId,
      certificateFingerprint: cert.fingerprint,
      certificateId: 'cert-local',
    },
    verification: {
      licenseId,
      licenseVersion: 1,
      snapshotEtag: 'e'.repeat(64),
      expiresAt: new Date(NOW + 120000).toISOString(),
    },
  });
  const key = Buffer.alloc(64, 7);
  const input: LicenseInput = {
    runId: bound.manifest.runId,
    manifestHash: bound.hash,
    applicationCommit: bound.manifest.applicationCommit,
    toolCommit: bound.manifest.toolCommit,
    serialNumber: bound.manifest.serialNumber,
    model: bound.manifest.model,
    deviceId,
    customerId,
    certificateFingerprint: cert.fingerprint,
    snapshotEtag: 'e'.repeat(64),
    nonce: 'd'.repeat(64),
    expiresAtMs: NOW + 60000,
    license: {
      licenseId,
      version: 1,
      effective: true,
      status: 'ACTIVE',
      entitlements: ['REMOTE_CONTROL', 'OTA'],
      signature: '',
      signaturePayload: {
        licenseId,
        deviceId,
        customerId,
        validFrom: new Date(NOW - 1000).toISOString(),
        validTo: new Date(NOW + 86400000).toISOString(),
        entitlements: ['OTA', 'REMOTE_CONTROL'],
      },
    },
  };
  input.license.signature = signLicensePayload(key.toString('utf8'), {
    ...input.license.signaturePayload,
    validFrom: new Date(input.license.signaturePayload.validFrom),
    validTo: new Date(input.license.signaturePayload.validTo),
    entitlements: ['REMOTE_CONTROL', 'OTA_UPDATE'],
  });
  let now = NOW,
    reads = 0;
  const material = Buffer.from(key);
  const deps: { now(): number; loadSecret(): Promise<SecretMaterial> } = {
    now: () => now,
    loadSecret: async () => {
      reads++;
      return { arn: TARGET.licenseSecretArn, versionId: bound.manifest.licenseSecretVersion, key: material };
    },
  };
  return {
    bound,
    input,
    key,
    material,
    deps,
    setNow: (value: number) => {
      now = value;
    },
    get reads() {
      return reads;
    },
    invoke: () => createLicenseVerifier(bound, deps)(input, context('verifier', bound)),
  };
}
test('independent verifier agrees with actual signer and returns only bound hashes and receipt metadata', async () => {
  const f = fixture(),
    r = await f.invoke();
  expect(r.status).toBe('VERIFIED');
  expect(f.reads).toBe(1);
  expect(f.material.every((x) => x === 0)).toBe(true);
  expect(r).toMatchObject({
    manifestHash: f.bound.hash,
    snapshotEtag: f.input.snapshotEtag,
    nonce: f.input.nonce,
    licenseVersion: 1,
    keyExported: false,
  });
  expect(JSON.stringify(r)).not.toContain(f.input.license.signature);
  expect(JSON.stringify(r)).not.toContain(f.key.toString('utf8'));
});
for (const [label, mutate] of [
  [
    'foreign run',
    (e: any) => {
      e.runId = 'IMG21-foreign';
    },
  ],
  [
    'manifest',
    (e: any) => {
      e.manifestHash = 'a'.repeat(64);
    },
  ],
  [
    'application candidate',
    (e: any) => {
      e.applicationCommit = 'b'.repeat(40);
    },
  ],
  [
    'tool candidate',
    (e: any) => {
      e.toolCommit = 'b'.repeat(40);
    },
  ],
  [
    'device',
    (e: any) => {
      e.deviceId = randomUUID();
    },
  ],
  [
    'tenant',
    (e: any) => {
      e.customerId = randomUUID();
    },
  ],
  [
    'serial prefix rewrite',
    (e: any) => {
      e.serialNumber = 'syncprobe-0123456789abcdef';
    },
  ],
  [
    'model',
    (e: any) => {
      e.model = 'other';
    },
  ],
  [
    'certificate',
    (e: any) => {
      e.certificateFingerprint = 'b'.repeat(64);
    },
  ],
  [
    'snapshot',
    (e: any) => {
      e.snapshotEtag = 'b'.repeat(64);
    },
  ],
  [
    'unsigned version',
    (e: any) => {
      e.license.version = 2;
    },
  ],
  [
    'different license',
    (e: any) => {
      e.license.licenseId = randomUUID();
    },
  ],
  [
    'ineffective license',
    (e: any) => {
      e.license.effective = false;
    },
  ],
  [
    'revoked status',
    (e: any) => {
      e.license.status = 'REVOKED';
    },
  ],
  [
    'expired nonce',
    (e: any) => {
      e.expiresAtMs = NOW;
    },
  ],
  [
    'excessive TTL',
    (e: any) => {
      e.expiresAtMs = NOW + 300001;
    },
  ],
  [
    'invalid nonce',
    (e: any) => {
      e.nonce = 'n';
    },
  ],
  [
    'date-only signature',
    (e: any) => {
      e.license.signaturePayload.validFrom = '2026-11-08';
    },
  ],
  [
    'duplicate entitlement',
    (e: any) => {
      e.license.entitlements.push('OTA');
    },
  ],
  [
    'non-wire entitlement',
    (e: any) => {
      e.license.signaturePayload.entitlements = ['ota'];
    },
  ],
  [
    'unsorted entitlement',
    (e: any) => {
      e.license.signaturePayload.entitlements.reverse();
    },
  ],
  [
    'legacy MAC',
    (e: any) => {
      e.license.signature = e.license.signature.slice(3);
    },
  ],
  [
    'unknown nested payload',
    (e: any) => {
      e.license.signaturePayload.sql = 'query';
    },
  ],
  [
    'unknown event field',
    (e: any) => {
      e.loadSecret = true;
    },
  ],
] as const)
  test(`${label} is rejected before reading secret`, async () => {
    const f = fixture();
    mutate(f.input);
    expect((await f.invoke()).status).toBe('REJECTED');
    expect(f.reads).toBe(0);
  });
test('well formed but incorrect HMAC is rejected and key cleared', async () => {
  const f = fixture();
  f.input.license.signature = 'v1.' + Buffer.alloc(32, 9).toString('base64url');
  expect((await f.invoke()).code).toBe('SIGNATURE_REJECTED');
  expect(f.reads).toBe(1);
  expect(f.material.every((x) => x === 0)).toBe(true);
});
test('valid MAC with noncanonical base64url padding bits is rejected before reading key', async () => {
  const f = fixture();
  const s = f.input.license.signature,
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    idx = alphabet.indexOf(s.at(-1)!);
  f.input.license.signature = s.slice(0, -1) + alphabet[idx + 1];
  expect((await f.invoke()).code).toBe('CANONICAL_SIGNATURE_REQUIRED');
  expect(f.reads).toBe(0);
});
test('wrong secret version is rejected, material is cleared and no raw SDK errors escape', async () => {
  const f = fixture();
  f.deps.loadSecret = async () => ({ arn: TARGET.licenseSecretArn, versionId: 'wrong', key: f.material });
  expect((await f.invoke()).code).toBe('EXACT_SECRET_VERSION_REQUIRED');
  expect(f.material.every((x) => x === 0)).toBe(true);
  f.deps.loadSecret = async () => {
    throw Error('sensitive provider text');
  };
  expect(await f.invoke()).toEqual({ status: 'REJECTED', code: 'VERIFICATION_UNAVAILABLE', keyExported: false });
});
test('old response after I/O deadline or changed input during await is rejected and cleared', async () => {
  const f = fixture(),
    load = f.deps.loadSecret;
  f.deps.loadSecret = async () => {
    const r = await load();
    f.setNow(f.input.expiresAtMs);
    return r;
  };
  expect((await f.invoke()).status).toBe('REJECTED');
  expect(f.material.every((x) => x === 0)).toBe(true);
  const g = fixture(),
    load2 = g.deps.loadSecret;
  g.deps.loadSecret = async () => {
    const r = await load2();
    g.input.license.version = 99;
    return r;
  };
  expect((await g.invoke()).status).toBe('REJECTED');
});
test('window expiry and alias invocation fail before key lookup', async () => {
  const f = fixture();
  f.setNow(Date.parse(f.bound.manifest.window.endsAt));
  expect((await f.invoke()).code).toBe('WINDOW_NOT_OPEN');
  expect(f.reads).toBe(0);
  const g = fixture();
  expect(
    (
      await createLicenseVerifier(g.bound, g.deps)(g.input, {
        ...context('verifier', g.bound),
        invokedFunctionArn: context('verifier', g.bound).invokedFunctionArn.replace(/:2$/u, ':current'),
      })
    ).code,
  ).toBe('PUBLISHED_VERSION_REQUIRED');
  expect(g.reads).toBe(0);
});
test('SDK secret adapter pins exact ARN and VersionId, never AWSCURRENT or historical fallbacks', async () => {
  const commands: any[] = [];
  const port = createSecretPort('1'.repeat(32), {
    send: async (command, options) => {
      commands.push(command);
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      return { ARN: TARGET.licenseSecretArn, VersionId: '1'.repeat(32), SecretString: 'k'.repeat(64) };
    },
  });
  const result = await port();
  expect(commands[0].constructor.name).toBe('GetSecretValueCommand');
  expect(commands[0].input).toEqual({ SecretId: TARGET.licenseSecretArn, VersionId: '1'.repeat(32) });
  expect(result.key.length).toBe(64);
  result.key.fill(0);
});
test('SDK identity adapter fetches exact pool metadata/groups and rejects truncated group pages', async () => {
  const commands: any[] = [];
  const username = 'img21-0123456789abcdef-admin';
  const port = createIdentityPort({
    send: async (command) => {
      commands.push(command);
      return command.constructor.name === 'AdminGetUserCommand'
        ? {
            Username: username,
            UserCreateDate: new Date(NOW - 1000),
            Enabled: true,
            UserAttributes: [
              { Name: 'sub', Value: 'sub' },
              { Name: 'email', Value: 'admin@example.invalid' },
            ],
          }
        : { Groups: [{ GroupName: 'PlatformSuperAdmin' }], NextToken: 'more' };
    },
  });
  await expect(port(username)).rejects.toThrow('INVALID_COGNITO_METADATA');
  expect(commands.every((c) => c.input.UserPoolId === TARGET.poolId && c.input.Username === username)).toBe(true);
});
test('immutable manifest rejects untrusted bytes, excessive windows and duplicated actor identity', () => {
  const f = fixture(),
    raw = JSON.stringify(f.bound.manifest);
  expect(() => bindManifest(raw, '0'.repeat(64))).toThrow('MANIFEST_DIGEST_MISMATCH');
  for (const mutate of [
    (m: any) => {
      m.window.endsAt = '2026-11-08T15:00:00.000Z';
    },
    (m: any) => {
      m.viewer = m.provisioner;
    },
    (m: any) => {
      m.writerVersion = '$LATEST';
    },
    (m: any) => {
      m.verification.licenseVersion = 0;
    },
  ]) {
    const m = JSON.parse(raw);
    mutate(m);
    const s = JSON.stringify(m);
    expect(() => bindManifest(s, digest(s))).toThrow();
  }
  expect(Object.isFrozen(f.bound.manifest.window)).toBe(true);
});

test('short keys fail closed and are cleared; unexpected ARN cannot be used with a valid signature', async () => {
  const f = fixture(),
    small = Buffer.alloc(16, 3);
  f.deps.loadSecret = async () => ({
    arn: TARGET.licenseSecretArn,
    versionId: f.bound.manifest.licenseSecretVersion,
    key: small,
  });
  expect((await f.invoke()).code).toBe('EXACT_SECRET_VERSION_REQUIRED');
  expect(small.every((x) => x === 0)).toBe(true);
  const g = fixture();
  g.deps.loadSecret = async () => ({
    arn: TARGET.dbSecretArn,
    versionId: g.bound.manifest.licenseSecretVersion,
    key: g.material,
  });
  expect((await g.invoke()).status).toBe('REJECTED');
  expect(g.material.every((x) => x === 0)).toBe(true);
});
test('verifier without a frozen license snapshot cannot read secret material', async () => {
  const f = fixture(),
    bound = manifest({ verifierBinding: f.bound.manifest.verifierBinding });
  expect((await createLicenseVerifier(bound, f.deps)(f.input, context('verifier', bound))).code).toBe(
    'VERIFIER_BINDING_NOT_READY',
  );
  expect(f.reads).toBe(0);
});
test('a valid signature payload changed after signing is rejected, independent of the cloud signer', async () => {
  const f = fixture();
  f.input.license.signaturePayload.validTo = new Date(NOW + 7200000).toISOString();
  expect((await f.invoke()).code).toBe('SIGNATURE_REJECTED');
});
