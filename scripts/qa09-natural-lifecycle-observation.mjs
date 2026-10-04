import { request } from 'node:https';

/** Redacted observation only: serving or acknowledging Sync never proves firmware applied a license. */
export function projectLicenseSync(response, expectedDeviceId, expectedLicenseId) {
  const snapshot = response.body?.data ?? response.body;
  return {
    status: response.status,
    errorCode: response.errorCode ?? null,
    requestId: response.requestId ?? null,
    deviceMatches: snapshot?.deviceId === expectedDeviceId,
    licenseMatches: snapshot?.license?.licenseId === expectedLicenseId,
    licenseStatus: snapshot?.license?.status ?? null,
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
  const licensed = deliveryGate === 'PASS' && readbackGate === 'PASS' && issued?.lifecycleStatus === 'Licensed';
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

export async function readOwnLicenseSync(ctx, licenseId, lastSyncTime = null) {
  const id = ctx.receipt.devices[0];
  if (!/^qa09-[a-f0-9]{16}-01$/.test(id) || !/^[a-f0-9-]{36}$/.test(licenseId))
    throw Error('OWN_DEVICE_LICENSE_REQUIRED');
  const held = ctx.held.get(id);
  if (!held?.cert || !held?.key) throw Error('REAL_DEVICE_CERTIFICATE_REQUIRED');
  const body = JSON.stringify({ lastSyncTime });
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
  return projectLicenseSync(response, id, licenseId);
}
