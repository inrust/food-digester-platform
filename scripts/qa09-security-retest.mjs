import { assertBusinessContext } from './qa09-business-target.mjs';
import { forgeClaimsToken } from './qa09-write-boundary-probes.mjs';

export async function runSecurityRetest(ctx) {
  assertBusinessContext(ctx);
  const r = {
    scope: 'TWO_MISSING_AUTHORIZATION_RESPONSES_AND_SIX_FORGED_JWT_REJECTIONS',
    gate: 'RUNNING',
    fullQa09Accepted: false,
    checks: [],
  };
  ctx.businessReceipt.remaining = r;
  const proof = (id, ok) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
    ctx.save();
    if (!ok) throw Error('SECURITY_RETEST_ASSERTION_FAILED');
  };
  try {
    const before = await ctx.db('business-baseline');
    for (const [id, role, path] of [
      ['retireDevice', 'CustomerViewer', '/api/v1/admin/devices/' + ctx.devices[0] + '/retire'],
      ['createFirmwareUpload', 'CustomerAdmin', '/api/v1/admin/ota/packages/upload-sessions'],
    ])
      await ctx.api(
        'security-retest:' + id + ':' + role,
        role,
        'POST',
        path,
        403,
        { qa09UnknownField: true },
        { 'If-Match': '-1' },
      );
    const token = ctx.sessions.get('PlatformSuperAdmin').idToken;
    const original = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    for (const [name, claims] of [
      ['expired', { ...original, exp: 1 }],
      ['future-nbf', { ...original, nbf: 4102444800 }],
      ['wrong-issuer', { ...original, iss: 'https://example.invalid' }],
      ['wrong-audience', { ...original, aud: 'invalid' }],
      ['escalated-groups', { ...original, 'cognito:groups': ['PlatformSuperAdmin'] }],
      ['wrong-token-use', { ...original, token_use: 'access' }],
    ])
      await ctx.api(
        'security-retest:jwt-' + name,
        null,
        'GET',
        '/api/v1/admin/devices/' + ctx.devices[0],
        [401, 403],
        undefined,
        { Authorization: 'Bearer ' + forgeClaimsToken(token, claims) },
      );
    await ctx.api(
      'security-retest:valid-token',
      'PlatformSuperAdmin',
      'GET',
      '/api/v1/admin/devices/' + ctx.devices[0],
      200,
    );
    const after = await ctx.db('business-baseline');
    proof(
      'no-business-effects',
      JSON.stringify(before.counts) === JSON.stringify(after.counts) &&
        JSON.stringify(before.businessFingerprints) === JSON.stringify(after.businessFingerprints),
    );
    const audit = await ctx.api(
      'security-retest:audit',
      'PlatformSuperAdmin',
      'GET',
      '/api/v1/admin/audit-logs?limit=100',
      200,
    );
    const raw = JSON.stringify(audit);
    const canaries = [...ctx.sessions.values()]
      .map((x) => x.idToken)
      .concat([...ctx.logins.values()].map((x) => x.password));
    proof(
      'audit-no-credentials',
      !/-----BEGIN [A-Z ]*PRIVATE KEY|\bBearer [A-Za-z0-9._~-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/.test(raw) &&
        !canaries.some((x) => raw.includes(x)),
    );
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.failureCode = /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'SECURITY_RETEST_FAILED';
  }
  ctx.save();
  return r;
}
