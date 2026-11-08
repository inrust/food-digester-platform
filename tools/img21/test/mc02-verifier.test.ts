import { expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { fixtureInput, FIXTURE_NOW as NOW } from '../local-fixture.js';
import { renderWriterManifest, renderVerifierManifest } from '../manifests.js';
import { createLicenseVerifier } from '../license-verifier.js';
import { TARGET } from '../contracts.js';
import { functionArn } from '../policies.js';
function fixture() {
  const f = fixtureInput(),
    writer = renderWriterManifest(f.manifest),
    bound = renderVerifierManifest(writer, f.snapshot, NOW),
    m = bound.manifest,
    b = f.snapshot.binding;
  const p = {
    licenseId: f.snapshot.licenseId,
    deviceId: b.deviceId,
    customerId: b.customerId,
    validFrom: new Date(NOW - 1000).toISOString(),
    validTo: new Date(NOW + 86400000).toISOString(),
    entitlements: ['OTA', 'REMOTE_CONTROL'],
  };
  const key = Buffer.alloc(64, 3),
    signature = 'v1.' + createHmac('sha256', key).update(JSON.stringify(p)).digest('base64url');
  const event = {
    runId: m.runId,
    manifestHash: bound.hash,
    applicationCommit: m.applicationCommit,
    toolCommit: m.toolCommit,
    serialNumber: m.serialNumber,
    model: m.model,
    deviceId: b.deviceId,
    customerId: b.customerId,
    certificateFingerprint: b.certificateFingerprint,
    snapshotEtag: f.snapshot.snapshotEtag,
    nonce: 'd'.repeat(64),
    expiresAtMs: NOW + 300000,
    license: {
      licenseId: p.licenseId,
      version: 1,
      effective: true,
      status: 'ACTIVE',
      entitlements: p.entitlements,
      signature,
      signaturePayload: p,
    },
  };
  let time = NOW,
    reads = 0;
  const material = Buffer.from(key);
  const deps = {
    now: () => time,
    loadSecret: async () => {
      reads++;
      return { arn: TARGET.licenseSecretArn, versionId: m.licenseSecretVersion, key: material };
    },
  };
  const context = { functionVersion: '37', invokedFunctionArn: functionArn('verifier') + ':37' };
  return {
    bound,
    event,
    deps,
    context,
    material,
    setNow: (n: number) => {
      time = n;
    },
    get reads() {
      return reads;
    },
  };
}
test('post-publication numeric context and pinned snapshot verify real HMAC successfully', async () => {
  const f = fixture(),
    result = await createLicenseVerifier(f.bound, f.deps)(f.event, f.context);
  expect(result.status).toBe('VERIFIED');
  expect(f.material.every((x) => x === 0)).toBe(true);
});
for (const offset of [-1, 300000, 300001])
  test(`snapshot clock offset ${offset} rejects before key access`, async () => {
    const f = fixture();
    f.setNow(NOW + offset);
    expect((await createLicenseVerifier(f.bound, f.deps)(f.event, f.context)).status).toBe('REJECTED');
    expect(f.reads).toBe(0);
  });
test('five-minute expiry during key I/O rejects a late success and clears key memory', async () => {
  const f = fixture(),
    load = f.deps.loadSecret;
  f.deps.loadSecret = async () => {
    const k = await load();
    f.setNow(NOW + 300000);
    return k;
  };
  expect((await createLicenseVerifier(f.bound, f.deps)(f.event, f.context)).status).toBe('REJECTED');
  expect(f.material.every((x) => x === 0)).toBe(true);
});
