import { request } from 'node:https';
import { writeFileSync } from 'node:fs';
function devicePost(cert, key, route) {
  if (!['deactivate', 'sync'].includes(route)) throw Error('FIXED_DEVICE_ROUTE_REQUIRED');
  return new Promise((resolve) => {
    const req = request(
      `https://device-api.bio-nexa.com/api/v1/device/${route}`,
      {
        method: 'POST',
        cert,
        key,
        rejectUnauthorized: true,
        timeout: 15000,
      },
      (res) => {
        let bytes = '';
        res.on('data', (b) => {
          bytes += b;
          if (bytes.length > 262144) req.destroy();
        });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(bytes);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode, body, requestId: res.headers['x-amzn-requestid'] ?? null });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => resolve({ status: 0, errorCode: e.code ?? 'TLS_FAILURE' }));
    req.end();
  });
}
export async function runDeviceConfirmationProbes(ctx, api, record, output) {
  const id = ctx.receipt.devices[1],
    key = ctx.held.get(id);
  const r = { scope: 'OWN_DEVICE_CONFIRMED_RETIREMENT', deviceId: id, checks: [], fullQa09Accepted: false };
  const check = (name, ok, data) => {
    r.checks.push({ id: name, result: ok ? 'PASS' : 'FAIL', ...data });
    record(name, ok, data);
  };
  try {
    const early = await devicePost(key.cert, key.key, 'deactivate');
    check('device-confirmation-before-retirement-denied', early.status === 409, {
      status: early.status,
      requestId: early.requestId,
    });
    await api('device-confirmation-retire', 'PlatformSuperAdmin', 'POST', `/api/v1/admin/devices/${id}/retire`, 200, {
      reason: ctx.receipt.prefix,
      confirm: true,
    });
    const pending = await devicePost(key.cert, key.key, 'sync');
    check('device-confirmation-pending-sync-allowed', pending.status === 200, {
      status: pending.status,
      requestId: pending.requestId,
    });
    const confirmed = await devicePost(key.cert, key.key, 'deactivate');
    check(
      'real-device-deactivation-confirmed',
      confirmed.status === 200 &&
        confirmed.body?.data?.retirement?.status === 'CONFIRMED' &&
        confirmed.body?.data?.retirement?.completionMethod === 'DEVICE_CONFIRM',
      {
        status: confirmed.status,
        requestId: confirmed.requestId,
        retirementStatus: confirmed.body?.data?.retirement?.status,
        completionMethod: confirmed.body?.data?.retirement?.completionMethod,
      },
    );
    const replay = await devicePost(key.cert, key.key, 'deactivate');
    check('real-device-deactivation-replay', replay.status === 200 && replay.body?.data?.replayed === true, {
      status: replay.status,
      requestId: replay.requestId,
      replayed: replay.body?.data?.replayed,
    });
    const revoked = await devicePost(key.cert, key.key, 'sync');
    check('device-confirmed-revoked-sync-denied', [401, 403].includes(revoked.status), {
      status: revoked.status,
      requestId: revoked.requestId,
    });
  } catch (e) {
    r.failure = { errorName: e.name, code: e.code ?? 'DEVICE_CONFIRMATION_EXECUTOR_FAILED' };
  } finally {
    r.gate = !r.failure && r.checks.length === 5 && r.checks.every((x) => x.result === 'PASS') ? 'PASS' : 'FAIL';
    writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  }
  return r;
}
