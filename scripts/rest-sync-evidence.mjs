/** Pure evidence helpers: preserve snapshot facts without persisting device verifiers. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const sha = (v) => createHash('sha256').update(v).digest('hex');
export function snapshotEtag(s) {
  return sha(
    JSON.stringify({
      assignment: s.assignment,
      configuration: s.configuration,
      device: s.device,
      deviceUsers: s.deviceUsers,
      license: s.license,
      operationalStatus: {
        lifecycleStatus: s.operationalStatus.lifecycleStatus,
        operationalStatus: s.operationalStatus.operationalStatus,
        syncIntervalSeconds: s.operationalStatus.syncIntervalSeconds,
      },
    }),
  );
}
export function publicSnapshot(snapshot) {
  const body = structuredClone(snapshot),
    verifierDigests = [];
  for (const user of body.deviceUsers ?? []) {
    const phc = user.passwordHash;
    if (typeof phc !== 'string' || !/^\$argon2id\$v=19\$m=32768,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(phc))
      throw Error('INVALID_DEVICE_VERIFIER');
    const parts = phc.split('$');
    const saltBytes = Buffer.from(parts[4], 'base64').length,
      hashBytes = Buffer.from(parts[5], 'base64').length;
    if (saltBytes !== 16 || hashBytes !== 32) throw Error('INVALID_VERIFIER_LENGTH');
    verifierDigests.push({
      userId: user.userId,
      sha256: sha(phc),
      algorithm: 'argon2id',
      version: 19,
      memoryKiB: 32768,
      iterations: 3,
      parallelism: 1,
      saltBytes,
      hashBytes,
    });
    user.passwordHash = '[REDACTED:device-verifier]';
  }
  return { body, verifierDigests, computedEtag: snapshotEtag(snapshot), verifierRedacted: verifierDigests.length > 0 };
}
export function evaluateSnapshot(row, expected, state) {
  const s = row.body,
    d = state.devices.find((v) => v.id === expected.deviceId),
    a = state.assignments.find((v) => v.id === s.assignment?.assignmentId),
    l = state.licenses.find((v) => v.id === expected.licenseId);
  const same = isDeepStrictEqual;
  const eligible = state.deviceUsers.filter(
    (u) =>
      u.customer_id === expected.customerId &&
      u.status === 'ACTIVE' &&
      state.userAssignments.some(
        (v) => v.device_user_id === u.id && v.device_id === expected.deviceId && v.status === 'ACTIVE',
      ),
  );
  return {
    schema: row.schemaValid === true,
    complete: ['assignment', 'device', 'license', 'configuration', 'deviceUsers', 'operationalStatus'].every((k) =>
      Object.hasOwn(s, k),
    ),
    identity:
      s.deviceId === expected.deviceId &&
      s.device.deviceId === expected.deviceId &&
      s.device.serialNumber === expected.serial &&
      s.device.model === expected.model &&
      s.device.alias === expected.alias &&
      s.device.firmwareVersion === d?.firmware_version,
    assignment:
      !!a &&
      s.assignment.customerId === expected.customerId &&
      s.assignment.siteId === expected.siteId &&
      s.assignment.customerName === expected.customerName &&
      s.assignment.siteName === expected.siteName &&
      s.assignment.region === expected.region &&
      s.assignment.subregion === expected.subregion &&
      a.customer_id === expected.customerId &&
      a.site_id === expected.siteId &&
      a.status === 'ACTIVE' &&
      a.ended_at === null &&
      s.assignment.endedAt === null &&
      s.assignment.assignedAt === a.assigned_at,
    license:
      !!l &&
      s.license?.licenseId === l.id &&
      s.license.status === 'ACTIVE' &&
      l.status === 'Active' &&
      s.license.version === l.version &&
      s.license.effective === true &&
      s.license.validFrom === l.valid_from.slice(0, 10) &&
      s.license.validTo === l.valid_to.slice(0, 10) &&
      s.license.signature === l.signature &&
      /^v1\.[A-Za-z0-9_-]{43}$/.test(s.license.signature),
    signaturePayload: same(s.license?.signaturePayload, {
      licenseId: expected.licenseId,
      deviceId: expected.deviceId,
      customerId: expected.customerId,
      validFrom: l?.valid_from,
      validTo: l?.valid_to,
      entitlements: ['ESG_REPORTING', 'OTA', 'REMOTE_CONTROL'],
    }),
    entitlements:
      same(
        [...(s.license?.entitlements ?? [])].sort(),
        state.entitlements
          .filter((v) => v.license_id === expected.licenseId && v.enabled)
          .map((v) => (v.code === 'OTA_UPDATE' ? 'OTA' : v.code))
          .sort(),
      ) && same([...(s.license?.entitlements ?? [])].sort(), ['ESG_REPORTING', 'OTA', 'REMOTE_CONTROL']),
    configuration: same(s.configuration, expected.configuration),
    users:
      s.deviceUsers.length === 1 &&
      s.deviceUsers[0].userId === expected.userId &&
      s.deviceUsers[0].displayName === expected.displayName &&
      s.deviceUsers[0].status === 'ACTIVE' &&
      same(s.deviceUsers.map((u) => u.userId).sort(), eligible.map((u) => u.id).sort()) &&
      row.verifierDigests.length === 1 &&
      row.verifierDigests.every((v) =>
        eligible.some((u) => u.id === v.userId && u.argon2id && u.password_hash_sha256 === v.sha256),
      ),
    operational:
      s.operationalStatus.lifecycleStatus === expected.lifecycle &&
      d?.lifecycle_status === expected.lifecycle &&
      s.operationalStatus.operationalStatus === state.latest[0]?.operational_status &&
      s.operationalStatus.syncIntervalSeconds === 300 &&
      s.operationalStatus.lastHeartbeatAt === state.latest[0]?.last_heartbeat_at,
    etag: row.computedEtag === s.etag && /^[a-f0-9]{64}$/.test(s.etag),
  };
}
export function ownArchivePrefix(customerId) {
  if (!/^[a-f0-9-]{36}$/.test(customerId)) throw Error('INVALID_OWN_CUSTOMER');
  return `domain/entity_type=license/customer_id=${customerId}/`;
}
