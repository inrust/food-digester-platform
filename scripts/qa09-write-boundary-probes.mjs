import { DELIVERED_OPERATIONS } from '../apps/cloud-api/src/runtime/delivered-operations.ts';
import { hasPermission } from '../packages/auth/src/permissions.ts';
export function writePermission(operation) {
  const p = operation.path;
  if (p.includes('/certificate-rotation-requests')) return 'certificate:rotate';
  if (p.includes('/onboarding/')) return 'onboarding:approve';
  if (p.includes('/replay/')) return 'replay:create';
  if (p.includes('/commands')) return 'command:send';
  if (p.includes('/activities/export') || p.includes('/esg/exports')) return 'export:create';
  if (p.includes('/device-users')) return 'device-user:write';
  if (p.includes('/consumable-requests')) return 'device:write';
  if (p.includes('/configurations')) return 'config:publish';
  if (p.includes('/contracts')) return 'contract:write';
  if (p.includes('/licenses')) return 'license:write';
  if (p.includes('/alarms')) return 'alarm:write';
  if (p.includes('/ota/')) return 'ota:write';
  if (p.includes('/settings')) return 'settings:write';
  if (p.includes('/platform-users') || p.includes('/users')) return 'user:write';
  if (p.includes('/sites')) return 'site:write';
  if (p.includes('/customers')) return 'customer:write';
  if (p.endsWith('/assignment')) return 'device:assign';
  if (p.includes('/devices/')) return 'device:write';
  throw Error('UNMAPPED_WRITE_PERMISSION:' + operation.operationId);
}
export const WRITES = DELIVERED_OPERATIONS.filter((o) => o.runtime === 'admin-api' && o.method !== 'GET');
export function ownProbePath(operation, prefix, deviceId) {
  if (!/^qa09-[a-f0-9]{16}$/.test(prefix) || !deviceId.startsWith(prefix + '-')) throw Error('OWN_PREFIX_REQUIRED');
  const absent = '00000000-0000-4000-8000-000000000000';
  return operation.path.replace(/\{([^}]+)\}/g, (_, key) =>
    key === 'deviceId' ? deviceId : key === 'version' ? '1' : key === 'key' ? prefix : absent,
  );
}
export function forgeClaimsToken(token, claims) {
  const parts = token.split('.');
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const payload =
    encoded === parts[1]
      ? Buffer.from(JSON.stringify({ ...claims, qa09Tampered: true })).toString('base64url')
      : encoded;
  return parts[0] + '.' + payload + '.' + parts[2];
}
export async function runWriteBoundaryProbes(ctx, api, sessions, record) {
  const prefix = ctx.receipt.prefix,
    deviceId = ctx.receipt.devices[0],
    roles = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
  const r = {
    scope: 'ALL_DELIVERED_WRITE_AUTH_AND_DENIED_ROLE_BOUNDARIES',
    operationCount: WRITES.length,
    authenticatedValidWritesExecuted: false,
    rows: [],
    jwt: [],
    fullQa09Accepted: false,
  };
  for (const operation of WRITES) {
    const path = ownProbePath(operation, prefix, deviceId),
      permission = writePermission(operation);
    for (const role of [null, ...roles]) {
      const expected = role === null ? 401 : hasPermission(role, permission) ? [400, 404, 409] : 403;
      try {
        await api(
          `write-boundary:${operation.operationId}:${role ?? 'anonymous'}`,
          role,
          operation.method,
          path,
          expected,
          { qa09UnknownField: true },
          { 'If-Match': '-1' },
        );
        r.rows.push({
          operationId: operation.operationId,
          role: role ?? 'anonymous',
          permission,
          expected,
          result: 'PASS',
          proof:
            role && hasPermission(role, permission) ? 'VALIDATION_OR_ABSENT_OBJECT_ONLY' : 'AUTHORIZATION_REJECTION',
        });
      } catch (e) {
        r.rows.push({
          operationId: operation.operationId,
          role: role ?? 'anonymous',
          permission,
          result: 'FAIL',
          failure: e.code ?? 'REQUEST_FAILED',
        });
      }
    }
  }
  const token = sessions.get('PlatformSuperAdmin').idToken,
    parts = token.split('.');
  const original = JSON.parse(Buffer.from(parts[1], 'base64url'));
  for (const [name, claims] of [
    ['expired', { ...original, exp: 1 }],
    ['future-nbf', { ...original, nbf: 4102444800 }],
    ['wrong-issuer', { ...original, iss: 'https://example.invalid' }],
    ['wrong-audience', { ...original, aud: 'invalid' }],
    ['escalated-groups', { ...original, 'cognito:groups': ['PlatformSuperAdmin'] }],
    ['wrong-token-use', { ...original, token_use: 'access' }],
  ]) {
    const forged = forgeClaimsToken(token, claims);
    try {
      await api('jwt-reject-' + name, null, 'GET', '/api/v1/admin/devices/' + deviceId, [401, 403], undefined, {
        Authorization: 'Bearer ' + forged,
      });
      r.jwt.push({ case: name, result: 'PASS', proof: 'FORGED_SIGNATURE_REJECTED_NOT_INDEPENDENT_SIGNED_CLAIM_TEST' });
    } catch (e) {
      r.jwt.push({ case: name, result: 'FAIL', code: e.code ?? 'REQUEST_FAILED' });
    }
  }
  await api('valid-jwt-reuse-first', 'PlatformSuperAdmin', 'GET', '/api/v1/admin/devices/' + deviceId, 200);
  await api('valid-jwt-reuse-second', 'PlatformSuperAdmin', 'GET', '/api/v1/admin/devices/' + deviceId, 200);
  record('all-write-boundaries-measured', r.rows.length === WRITES.length * 6, {
    operations: WRITES.length,
    requests: r.rows.length,
    authenticatedValidWritesExecuted: false,
  });
  return r;
}
