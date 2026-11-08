/** Local design reference only. No AWS/DB client, handler, deployment or target execution. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export const ACTIONS = [
  'SEED_PROVISIONER',
  'SEED_VIEWER',
  'BIND_DEVICE',
  'ENABLE_PREVIEW',
  'DISABLE_PREVIEW',
  'DISABLE_IDENTITY',
  'READ_OPERATION',
];
const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const reject = (code) => {
  throw new Error(code);
};
export function validateAction(spec, request, facts, now) {
  if (
    spec.target.accountId !== '065986019555' ||
    spec.target.region !== 'ap-southeast-1' ||
    spec.target.stackName !== 'fdp-test-app'
  )
    reject('TARGET_MISMATCH');
  if (
    !spec.window.approved ||
    Date.parse(spec.window.endsAt) - Date.parse(spec.window.startsAt) > 5400000 ||
    !Number.isFinite(Date.parse(spec.window.startsAt)) ||
    !(Date.parse(spec.window.startsAt) <= now && now < Date.parse(spec.window.endsAt))
  )
    reject('WINDOW_NOT_OPEN');
  if (
    Object.keys(request).some(
      (key) =>
        !['runId', 'manifestHash', 'operationId', 'action', 'userId', 'deviceId', 'expectedAuthEpoch'].includes(key),
    )
  )
    reject('UNKNOWN_REQUEST_FIELDS');
  if (
    request.runId !== spec.runId ||
    request.manifestHash !== spec.manifestHash ||
    !hash(request.operationId) ||
    !ACTIONS.includes(request.action)
  )
    reject('REQUEST_BINDING');
  if (
    !facts.authorityWrapperInstalled ||
    facts.controlTable !== 'fdp-test-live-image-control' ||
    facts.payloadTable !== 'fdp-test-live-image-payload'
  )
    reject('AUTHORITY_CONTEXT_REQUIRED');
  if (request.action === 'SEED_PROVISIONER' || request.action === 'SEED_VIEWER') {
    const expected = request.action === 'SEED_PROVISIONER' ? spec.provisioner : spec.viewer;
    if (
      facts.cognito?.username !== expected.username ||
      facts.cognito.role !== expected.role ||
      !facts.cognito.freshlyCreatedForRun ||
      facts.existingActorLeaseCount !== 0
    )
      reject('OWN_NEW_IDENTITY_REQUIRED');
    if (
      request.action === 'SEED_VIEWER' &&
      (!uuid(spec.binding?.customerId) || facts.customerId !== spec.binding.customerId)
    )
      reject('OWN_CUSTOMER_REQUIRED');
  } else if (request.action === 'DISABLE_IDENTITY' && !spec.binding?.deviceId) {
    if (
      !spec.boundUserIds?.includes(request.userId) ||
      !facts.ownedIdentityValidated ||
      facts.foreignActorLeaseCount !== 0 ||
      facts.ownedActorLeaseCount !== 0
    )
      reject('OWN_UNUSED_IDENTITY_REQUIRED');
  } else if (request.action === 'BIND_DEVICE') {
    if (
      spec.binding?.deviceId ||
      !uuid(request.deviceId) ||
      facts.deviceId !== request.deviceId ||
      facts.serialNumber !== spec.serialNumber ||
      !facts.serverCreatedForRun ||
      facts.customerName !== spec.customerName ||
      !uuid(facts.customerId) ||
      !hash(facts.certificateFingerprint) ||
      facts.otherDeviceCount !== 0
    )
      reject('OWN_IMMUTABLE_BINDING_REQUIRED');
  } else if (request.action !== 'READ_OPERATION') {
    if (
      !uuid(spec.binding?.deviceId) ||
      !uuid(spec.binding?.customerId) ||
      request.deviceId !== spec.binding.deviceId ||
      facts.deviceId !== request.deviceId ||
      facts.customerId !== spec.binding.customerId ||
      facts.serialNumber !== spec.serialNumber ||
      facts.otherDeviceCount !== 0
    )
      reject('OWN_SINGLE_DEVICE_REQUIRED');
    if (facts.authEpoch !== request.expectedAuthEpoch) reject('AUTHORITY_EPOCH_CHANGED');
    if (
      request.action === 'ENABLE_PREVIEW' &&
      (!['Active', 'Maintenance'].includes(facts.lifecycleStatus) ||
        !['Active', 'Maintenance'].includes(facts.operationalStatus) ||
        facts.certificateFingerprint !== spec.binding.certificateFingerprint ||
        !facts.certificateCurrent)
    )
      reject('DEVICE_NOT_ELIGIBLE');
    if (
      request.action === 'DISABLE_IDENTITY' &&
      (!spec.boundUserIds?.includes(request.userId) || facts.foreignActorLeaseCount !== 0)
    )
      reject('OWN_IDENTITY_ONLY');
  }
  return { status: 'PASS_LOCAL_CONTRACT_ONLY', executable: false };
}
export function receiptDecision(stored, requestHash) {
  if (!stored) return 'MAY_ATTEMPT_ONCE_AFTER_ALL_GUARDS';
  if (stored.requestHash !== requestHash) reject('IDEMPOTENCY_CONFLICT');
  if (stored.state === 'UNKNOWN') return 'QUERY_AND_RECONCILE_DO_NOT_RETRY';
  if (stored.state === 'SQL_COMMITTED_RECOVERY_FAILED') return 'SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED';
  if (stored.state !== 'COMMITTED') reject('UNSUPPORTED_RECEIPT_STATE');
  return 'REUSE_COMMITTED_RECEIPT';
}
export function canonicalLicense(payload) {
  return JSON.stringify({
    licenseId: payload.licenseId,
    deviceId: payload.deviceId,
    customerId: payload.customerId,
    validFrom: payload.validFrom,
    validTo: payload.validTo,
    entitlements: payload.entitlements,
  });
}
export function validateVerifier(spec, input, now) {
  if (!uuid(spec.binding?.deviceId) || !uuid(spec.binding?.customerId) || !hash(spec.binding?.certificateFingerprint))
    reject('DEVICE_BINDING_NOT_READY');
  if (
    !spec.window.approved ||
    Date.parse(spec.window.endsAt) - Date.parse(spec.window.startsAt) > 5400000 ||
    !(Date.parse(spec.window.startsAt) <= now && now < Date.parse(spec.window.endsAt))
  )
    reject('WINDOW_NOT_OPEN');
  if (
    input.runId !== spec.runId ||
    input.manifestHash !== spec.manifestHash ||
    input.serialNumber !== spec.serialNumber ||
    input.model !== spec.model ||
    input.deviceId !== spec.binding.deviceId ||
    input.customerId !== spec.binding.customerId ||
    input.certificateFingerprint !== spec.binding.certificateFingerprint ||
    !hash(input.snapshotEtag) ||
    !hash(input.nonce) ||
    !Number.isFinite(input.expiresAtMs) ||
    input.expiresAtMs <= now ||
    input.expiresAtMs > now + 300000 ||
    input.expiresAtMs > Date.parse(spec.window.endsAt)
  )
    reject('VERIFIER_REQUEST_BINDING');
  const payload = input.license?.signaturePayload;
  if (
    !payload ||
    Object.keys(payload).sort().join() !==
      ['customerId', 'deviceId', 'entitlements', 'licenseId', 'validFrom', 'validTo'].sort().join() ||
    !uuid(payload.licenseId) ||
    payload.licenseId !== input.license.licenseId ||
    payload.deviceId !== input.deviceId ||
    payload.customerId !== input.customerId ||
    !Number.isSafeInteger(input.license.version) ||
    input.license.version < 1 ||
    input.license.effective !== true ||
    !['ISSUED', 'ACTIVE', 'EXPIRING_SOON', 'RENEWED'].includes(input.license.status)
  )
    reject('LICENSE_PAYLOAD_BINDING');
  for (const key of ['validFrom', 'validTo'])
    if (!Number.isFinite(Date.parse(payload[key])) || new Date(payload[key]).toISOString() !== payload[key])
      reject('FULL_UTC_INSTANT_REQUIRED');
  if (
    !(Date.parse(payload.validFrom) <= now && now < Date.parse(payload.validTo)) ||
    !Array.isArray(payload.entitlements) ||
    !payload.entitlements.length ||
    payload.entitlements.some((e) => !['ESG_REPORTING', 'OTA', 'REMOTE_CONTROL'].includes(e)) ||
    JSON.stringify(payload.entitlements) !== JSON.stringify([...new Set(payload.entitlements)].sort()) ||
    !Array.isArray(input.license.entitlements) ||
    new Set(input.license.entitlements).size !== input.license.entitlements.length ||
    JSON.stringify([...input.license.entitlements].sort()) !== JSON.stringify(payload.entitlements) ||
    !/^v1\.[A-Za-z0-9_-]{43}$/u.test(input.license.signature ?? '')
  )
    reject('LICENSE_VALUE_INVALID');
  return payload;
}
export async function verifyWithPort(spec, input, { now, loadSecret }) {
  const payload = validateVerifier(spec, input, now()); // Must reject before key access.
  const secret = await loadSecret(); // Target adapter must bind exact ARN/version; not implemented here.
  if (!Buffer.isBuffer(secret)) reject('KEY_BUFFER_REQUIRED');
  try {
    if (secret.length < 32) reject('KEY_BUFFER_REQUIRED');
    if (now() >= input.expiresAtMs) reject('REQUEST_EXPIRED_AFTER_KEY_READ');
    const expected = createHmac('sha256', secret).update(canonicalLicense(payload)).digest();
    const supplied = Buffer.from(input.license.signature.slice(3), 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) reject('SIGNATURE_REJECTED');
    return {
      status: 'PASS_LOCAL_REFERENCE_SIGNATURE',
      runId: spec.runId,
      manifestHash: spec.manifestHash,
      deviceId: input.deviceId,
      certificateFingerprint: input.certificateFingerprint,
      licenseId: payload.licenseId,
      licenseVersion: input.license.version,
      expiresAtMs: input.expiresAtMs,
      snapshotEtag: input.snapshotEtag,
      signatureSha256: createHash('sha256').update(input.license.signature).digest('hex'),
      nonce: input.nonce,
      keyExported: false,
      targetExecuted: false,
    };
  } finally {
    secret.fill(0);
  }
}
