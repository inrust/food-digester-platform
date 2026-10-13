/** Independent simulated-device DEC-020 verifier. Does not import the cloud signer. */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const TEST_LICENSE_SECRET_ARN =
  'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-license-signing-key-OVgupB';
export function validateVerifierInput(input, now = Date.now()) {
  const p = input?.license?.signaturePayload;
  if (
    !/^qa09-[a-f0-9]{16}$/.test(input?.prefix ?? '') ||
    !new RegExp('^' + input.prefix + '-(0[1-9]|10)$').test(input.deviceId ?? '') ||
    !/^[a-f0-9-]{36}$/.test(input.customerId ?? '') ||
    !/^[a-f0-9]{40}$/.test(input.applicationCommit ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.snapshotEtag ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.certificateFingerprint ?? '') ||
    !/^[a-f0-9]{32}$/.test(input.nonce ?? '') ||
    !Number.isFinite(input.expiresAtMs) ||
    input.expiresAtMs <= now ||
    input.expiresAtMs > now + 300000 ||
    !p ||
    Object.keys(p).sort().join(',') !== 'customerId,deviceId,entitlements,licenseId,validFrom,validTo' ||
    p.deviceId !== input.deviceId ||
    p.customerId !== input.customerId ||
    p.licenseId !== input.license.licenseId ||
    !/^[a-f0-9-]{36}$/.test(p.licenseId) ||
    !Number.isSafeInteger(input.license.version) ||
    input.license.version < 1 ||
    !['ISSUED', 'ACTIVE', 'EXPIRING_SOON', 'RENEWED'].includes(input.license.status) ||
    input.license.effective !== true
  )
    throw Error('EXACT_CURRENT_DEVICE_LICENSE_INPUT_REQUIRED');
  for (const key of ['validFrom', 'validTo'])
    if (!Number.isFinite(Date.parse(p[key])) || new Date(p[key]).toISOString() !== p[key])
      throw Error('FULL_UTC_SIGNATURE_INSTANT_REQUIRED');
  if (!(Date.parse(p.validFrom) <= now && now < Date.parse(p.validTo))) throw Error('LICENSE_NOT_CURRENTLY_EFFECTIVE');
  if (
    !Array.isArray(p.entitlements) ||
    !p.entitlements.length ||
    p.entitlements.some((value) => !['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING'].includes(value)) ||
    new Set(p.entitlements).size !== p.entitlements.length ||
    JSON.stringify(p.entitlements) !== JSON.stringify([...p.entitlements].sort()) ||
    JSON.stringify([...(input.license.entitlements ?? [])].sort()) !== JSON.stringify(p.entitlements)
  )
    throw Error('WIRE_ENTITLEMENTS_REQUIRED');
  if (!/^v1\.[A-Za-z0-9_-]{43}$/.test(input.license.signature ?? '')) throw Error('LICENSE_SIGNATURE_FORMAT_REQUIRED');
  return p;
}
export function verifyDeviceLicense(input, key, now = Date.now()) {
  const p = validateVerifierInput(input, now);
  if (!(typeof key === 'string' || Buffer.isBuffer(key)) || Buffer.byteLength(key) < 32)
    throw Error('CONTROLLED_VERIFICATION_KEY_REQUIRED');
  const canonical = JSON.stringify({
    licenseId: p.licenseId,
    deviceId: p.deviceId,
    customerId: p.customerId,
    validFrom: p.validFrom,
    validTo: p.validTo,
    entitlements: p.entitlements,
  });
  const expected = createHmac('sha256', key).update(canonical).digest();
  const provided = Buffer.from(input.license.signature.slice(3), 'base64url');
  if (
    provided.length !== expected.length ||
    provided.toString('base64url') !== input.license.signature.slice(3) ||
    !timingSafeEqual(expected, provided)
  )
    throw Error('INDEPENDENT_LICENSE_SIGNATURE_REJECTED');
  return {
    gate: 'PASS_INDEPENDENT_SIMULATED_DEVICE_LICENSE_SIGNATURE',
    applicationCommit: input.applicationCommit,
    prefix: input.prefix,
    deviceId: input.deviceId,
    licenseId: p.licenseId,
    licenseVersion: input.license.version,
    snapshotEtag: input.snapshotEtag,
    certificateFingerprint: input.certificateFingerprint,
    nonce: input.nonce,
    expiresAtMs: input.expiresAtMs,
    canonicalPayloadSha256: digest(canonical),
    signatureSha256: digest(input.license.signature),
    keyExported: false,
    fullQa09Accepted: false,
    physicalDeviceAttested: false,
  };
}
export async function controlledLicenseVerification(input, { loadSecret, now = () => Date.now() }) {
  validateVerifierInput(input, now()); // Reject foreign/stale input before requesting secret material.
  const secret = await loadSecret(TEST_LICENSE_SECRET_ARN);
  if (secret?.arn !== TEST_LICENSE_SECRET_ARN || !secret.versionId || typeof secret.value !== 'string')
    throw Error('EXACT_TEST_SECRET_VERSION_REQUIRED');
  const key = Buffer.from(secret.value, 'utf8');
  try {
    return {
      ...verifyDeviceLicense(input, key, now()),
      secretVersionId: secret.versionId,
      secretArnSha256: digest(TEST_LICENSE_SECRET_ARN),
    };
  } finally {
    key.fill(0);
  }
}
