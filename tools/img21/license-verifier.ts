import { createHmac, timingSafeEqual } from 'node:crypto';
import { checkInvocation, checkWindow, digest, exactKeys, isHash, requireThat, Rejected } from './contracts.js';
import type { BoundManifest, Invocation } from './contracts.js';
export interface LicenseInput {
  runId: string;
  manifestHash: string;
  applicationCommit: string;
  toolCommit: string;
  serialNumber: string;
  model: string;
  deviceId: string;
  customerId: string;
  certificateFingerprint: string;
  snapshotEtag: string;
  nonce: string;
  expiresAtMs: number;
  license: {
    licenseId: string;
    version: number;
    effective: boolean;
    status: string;
    entitlements: string[];
    signature: string;
    signaturePayload: {
      licenseId: string;
      deviceId: string;
      customerId: string;
      validFrom: string;
      validTo: string;
      entitlements: string[];
    };
  };
}
export interface SecretMaterial {
  arn: string;
  versionId: string;
  key: Buffer;
}
export function validateLicenseEvent(bound: BoundManifest, event: unknown, ctx: Invocation, now: number): LicenseInput {
  checkInvocation(bound, 'verifier', ctx);
  checkWindow(bound, now);
  const { manifest: m } = bound,
    b = m.verifierBinding,
    v = m.verification;
  requireThat(b && v, 'VERIFIER_BINDING_NOT_READY');
  exactKeys(event, [
    'runId',
    'manifestHash',
    'applicationCommit',
    'toolCommit',
    'serialNumber',
    'model',
    'deviceId',
    'customerId',
    'certificateFingerprint',
    'snapshotEtag',
    'nonce',
    'expiresAtMs',
    'license',
  ]);
  requireThat(Buffer.byteLength(JSON.stringify(event)) <= 16384, 'INPUT_TOO_LARGE');
  const e = event as unknown as LicenseInput;
  requireThat(
    e.runId === m.runId &&
      e.manifestHash === bound.hash &&
      e.applicationCommit === m.applicationCommit &&
      e.toolCommit === m.toolCommit &&
      e.serialNumber === m.serialNumber &&
      e.model === m.model &&
      e.deviceId === b.deviceId &&
      e.customerId === b.customerId &&
      e.certificateFingerprint === b.certificateFingerprint &&
      e.snapshotEtag === v.snapshotEtag &&
      isHash(e.nonce) &&
      Number.isFinite(e.expiresAtMs) &&
      now < e.expiresAtMs &&
      e.expiresAtMs <= now + 300000 &&
      e.expiresAtMs <= Date.parse(v.expiresAt) &&
      e.expiresAtMs <= Date.parse(m.window.endsAt) &&
      now < Date.parse(v.expiresAt) &&
      Date.parse(v.expiresAt) <= now + 300000,
    'VERIFIER_REQUEST_BINDING',
  );
  exactKeys(e.license, [
    'licenseId',
    'version',
    'effective',
    'status',
    'entitlements',
    'signature',
    'signaturePayload',
  ]);
  const l = e.license,
    p = l.signaturePayload;
  exactKeys(p, ['licenseId', 'deviceId', 'customerId', 'validFrom', 'validTo', 'entitlements']);
  requireThat(
    l.licenseId === v.licenseId &&
      l.version === v.licenseVersion &&
      l.effective === true &&
      ['ISSUED', 'ACTIVE', 'EXPIRING_SOON', 'RENEWED'].includes(l.status) &&
      p.licenseId === l.licenseId &&
      p.deviceId === b.deviceId &&
      p.customerId === b.customerId,
    'LICENSE_METADATA_BINDING',
  );
  for (const key of ['validFrom', 'validTo'] as const)
    requireThat(
      typeof p[key] === 'string' && Number.isFinite(Date.parse(p[key])) && new Date(p[key]).toISOString() === p[key],
      'FULL_UTC_INSTANT_REQUIRED',
    );
  requireThat(Date.parse(p.validFrom) <= now && now < Date.parse(p.validTo), 'LICENSE_NOT_EFFECTIVE');
  requireThat(
    Array.isArray(p.entitlements) &&
      p.entitlements.length > 0 &&
      p.entitlements.every((s) => ['OTA', 'REMOTE_CONTROL', 'ESG_REPORTING'].includes(s)) &&
      JSON.stringify(p.entitlements) === JSON.stringify([...new Set(p.entitlements)].sort()) &&
      Array.isArray(l.entitlements) &&
      new Set(l.entitlements).size === l.entitlements.length &&
      JSON.stringify([...l.entitlements].sort()) === JSON.stringify(p.entitlements),
    'WIRE_ENTITLEMENTS_REQUIRED',
  );
  requireThat(
    typeof l.signature === 'string' &&
      /^v1\.[A-Za-z0-9_-]{43}$/u.test(l.signature) &&
      Buffer.from(l.signature.slice(3), 'base64url').toString('base64url') === l.signature.slice(3),
    'CANONICAL_SIGNATURE_REQUIRED',
  );
  return e;
}
export function createLicenseVerifier(
  bound: BoundManifest,
  deps: { now(): number; loadSecret(): Promise<SecretMaterial> },
) {
  return async (event: unknown, ctx: Invocation) => {
    let key: Buffer | undefined;
    try {
      let e = validateLicenseEvent(bound, event, ctx, deps.now());
      const secret = await deps.loadSecret();
      key = secret.key;
      requireThat(
        secret.arn ===
          'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-license-signing-key-OVgupB' &&
          secret.versionId === bound.manifest.licenseSecretVersion &&
          Buffer.isBuffer(key) &&
          key.length >= 32,
        'EXACT_SECRET_VERSION_REQUIRED',
      );
      e = validateLicenseEvent(bound, event, ctx, deps.now()); // Recheck expiry and every binding after awaited I/O.
      const p = e.license.signaturePayload;
      // Independent DEC-020 implementation; intentionally never imports the cloud signer.
      const canonical = JSON.stringify({
        licenseId: p.licenseId,
        deviceId: p.deviceId,
        customerId: p.customerId,
        validFrom: p.validFrom,
        validTo: p.validTo,
        entitlements: p.entitlements,
      });
      const expected = createHmac('sha256', key).update(canonical).digest();
      const actual = Buffer.from(e.license.signature.slice(3), 'base64url');
      requireThat(actual.length === expected.length && timingSafeEqual(expected, actual), 'SIGNATURE_REJECTED');
      checkWindow(bound, deps.now());
      requireThat(
        deps.now() < e.expiresAtMs && deps.now() < Date.parse(bound.manifest.verification!.expiresAt),
        'RESPONSE_EXPIRED',
      );
      return {
        status: 'VERIFIED' as const,
        runId: e.runId,
        manifestHash: bound.hash,
        applicationCommit: e.applicationCommit,
        toolCommit: e.toolCommit,
        invokedFunctionArn: ctx.invokedFunctionArn,
        deviceId: e.deviceId,
        customerId: e.customerId,
        certificateFingerprint: e.certificateFingerprint,
        licenseId: p.licenseId,
        licenseVersion: e.license.version,
        snapshotEtag: e.snapshotEtag,
        nonce: e.nonce,
        expiresAtMs: e.expiresAtMs,
        canonicalPayloadSha256: digest(canonical),
        signatureSha256: digest(e.license.signature),
        secretVersionId: secret.versionId,
        keyExported: false,
      };
    } catch (e) {
      return {
        status: 'REJECTED' as const,
        code: e instanceof Rejected ? e.code : 'VERIFICATION_UNAVAILABLE',
        keyExported: false,
      };
    } finally {
      if (Buffer.isBuffer(key)) key.fill(0);
    }
  };
}
