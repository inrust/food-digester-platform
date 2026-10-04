import { request } from 'node:https';

/** Redacted observation only: RECEIVED acknowledgement proves protocol receipt, never independent firmware verification. */
export function projectLicenseSync(response, expectedDeviceId, expectedLicenseId) {
  const snapshot = response.body?.data ?? response.body;
  return {
    status: response.status,
    errorCode: response.errorCode ?? null,
    requestId: response.requestId ?? null,
    deviceMatches: snapshot?.deviceId === expectedDeviceId,
    licenseMatches: snapshot?.license?.licenseId === expectedLicenseId,
    licenseStatus: snapshot?.license?.status ?? null,
    signaturePayloadPresent: !!snapshot?.license?.signaturePayload,
    signaturePresent: typeof snapshot?.license?.signature === 'string' && snapshot.license.signature.length > 0,
    lifecycleStatus: snapshot?.operationalStatus?.lifecycleStatus ?? null,
    snapshotAt: snapshot?.snapshotAt ?? null,
    firmwareVerificationClaimed: false,
  };
}

export function licenseSyncObservationGate(rows) {
  const phases = ['issued', 'activated'];
  const deliveryGate = phases.every((phase) =>
    rows.some(
      (r) =>
        r.phase === phase &&
        r.status === 200 &&
        r.deviceMatches &&
        r.licenseMatches &&
        r.signaturePresent &&
        r.licenseStatus === (phase === 'issued' ? 'ISSUED' : 'ACTIVE'),
    ),
  )
    ? 'PASS'
    : 'FAIL';
  const issued = rows.find((r) => r.phase === 'issued');
  const readbackGate = phases.every((phase) =>
    rows.some(
      (r) =>
        r.phase === phase && typeof r.adminLifecycleStatus === 'string' && r.adminLifecycleStatus === r.lifecycleStatus,
    ),
  )
    ? 'PASS'
    : 'FAIL';
  const licensed =
    deliveryGate === 'PASS' &&
    readbackGate === 'PASS' &&
    issued?.lifecycleStatus === 'Licensed' &&
    issued?.receiptConfirmationAccepted === true;
  return {
    licenseDeliveryGate: deliveryGate,
    lifecycleReadbackGate: readbackGate,
    assignedToLicensedGate: licensed ? 'PASS' : 'FAIL',
    licensedToActiveGate: 'NOT_RUN_NO_DELIVERED_DEVICE_VERIFICATION_ACK',
    naturalLifecycleGate: licensed ? 'PARTIAL' : 'FAIL',
    databaseActiveSeedUsed: false,
    fullQa09Accepted: false,
  };
}

async function requestOwnLicenseSync(ctx, licenseId, input) {
  const id = ctx.receipt.devices[0];
  if (!/^qa09-[a-f0-9]{16}-01$/.test(id) || !/^[a-f0-9-]{36}$/.test(licenseId))
    throw Error('OWN_DEVICE_LICENSE_REQUIRED');
  const held = ctx.held.get(id);
  if (!held?.cert || !held?.key) throw Error('REAL_DEVICE_CERTIFICATE_REQUIRED');
  const body = JSON.stringify(input);
  const response = await new Promise((resolve) => {
    const req = request(
      'https://device-api.bio-nexa.com/api/v1/device/sync',
      {
        method: 'POST',
        cert: held.cert,
        key: held.key,
        rejectUnauthorized: true,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      },
      (res) => {
        let bytes = '';
        res.on('data', (data) => {
          bytes += data;
          if (bytes.length > 262144) req.destroy();
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(bytes);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed, requestId: res.headers['x-amzn-requestid'] });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (error) => resolve({ status: 0, errorCode: error.code ?? 'TLS_FAILURE' }));
    req.end(body);
  });
  return response;
}

export async function readOwnLicenseSync(ctx, licenseId, lastSyncTime = null) {
  const response = await requestOwnLicenseSync(ctx, licenseId, { lastSyncTime });
  return projectLicenseSync(response, ctx.receipt.devices[0], licenseId);
}

/** This runner deliberately cannot construct VERIFIED; no firmware trust material is available. */
export async function confirmReceivedLicenseSnapshot(requestSync, deviceId, licenseId, lastSyncTime = null) {
  const first = await requestSync({ lastSyncTime });
  const s = first.body?.data ?? first.body;
  const base = projectLicenseSync(first, deviceId, licenseId);
  if (
    first.status !== 200 ||
    !base.deviceMatches ||
    !base.licenseMatches ||
    !base.signaturePresent ||
    !Number.isSafeInteger(s?.license?.version) ||
    s.license.version < 1 ||
    !/^[a-f0-9]{64}$/.test(s?.etag ?? '')
  )
    return { ...base, receiptConfirmationAccepted: false, confirmationGate: 'FAIL_SNAPSHOT_PRECONDITION' };
  const second = await requestSync({
    lastSyncTime: s.snapshotAt,
    licenseConfirmation: {
      licenseId,
      version: s.license.version,
      snapshotEtag: s.etag,
      status: 'RECEIVED',
    },
  });
  const row = projectLicenseSync(second, deviceId, licenseId);
  const accepted =
    row.status === 200 &&
    row.deviceMatches &&
    row.licenseMatches &&
    row.signaturePresent &&
    ['Licensed', 'Active'].includes(row.lifecycleStatus);
  return {
    ...row,
    deliveryRequestId: base.requestId,
    receiptConfirmationAccepted: accepted,
    confirmationGate: accepted ? 'PASS_RECEIVED_ONLY' : 'FAIL',
    independentHmacVerificationGate: 'NOT_RUN_NO_DEVICE_TRUST_CONFIGURATION',
  };
}

export function confirmOwnLicenseReceived(ctx, licenseId, lastSyncTime = null) {
  return confirmReceivedLicenseSnapshot(
    (input) => requestOwnLicenseSync(ctx, licenseId, input),
    ctx.receipt.devices[0],
    licenseId,
    lastSyncTime,
  );
}
