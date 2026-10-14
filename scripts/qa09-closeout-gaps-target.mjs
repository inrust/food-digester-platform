import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { runCloseoutBrowserGaps } from './qa09-closeout-browser-gaps.mjs';
export function containsActiveContractDevice(rows, deviceId) {
  return (
    Array.isArray(rows) &&
    rows.some(
      (x) =>
        x.association?.deviceId === deviceId && x.association?.status === 'ACTIVE' && x.device?.deviceId === deviceId,
    )
  );
}

// Only changed contract behavior and missing browser dimensions; no license, notification or Setting writes.
export async function runCloseoutGaps(ctx) {
  const r = {
    scope: 'CONTRACT_LIFECYCLE_BROWSER_DIFFERENCES_AND_UNKNOWN_USER_CONTAINMENT',
    gate: 'RUNNING',
    checks: [],
    contract: [],
    fullQa09Accepted: false,
  };
  ctx.businessReceipt.remaining = r;
  const proof = (id, ok, detail = {}) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...detail });
    ctx.save();
    if (!ok) throw Error('CLOSEOUT_GAP_PROOF_FAILED');
  };
  const api = (id, method, path, expected, body, headers) =>
    ctx.api('closeout:' + id, 'PlatformSuperAdmin', method, path, expected, body, headers);
  try {
    const now = Date.now();
    let c = (
      await api('contract-create', 'POST', '/api/v1/admin/contracts', 201, {
        contractNumber: ctx.prefix + '-closeout',
        name: ctx.prefix + '-closeout',
        customerId: ctx.customers[0].id,
        startAt: new Date(now - 86400000).toISOString(),
        endAt: new Date(now + 30 * 86400000).toISOString(),
      })
    ).data;
    const path = '/api/v1/admin/contracts/' + c.contractId;
    const read = async (step, expected) => {
      c = (await api('contract-read-' + step, 'GET', path, 200)).data;
      proof('contract-' + step + '-persisted', expected(c), { version: c.version, status: c.status });
      r.contract.push({ step, contractId: c.contractId, version: c.version, status: c.status });
      ctx.save();
    };
    await read('create', (x) => x.customerId === ctx.customers[0].id && x.status === 'DRAFT');
    await api(
      'contract-update',
      'PATCH',
      path,
      200,
      { name: ctx.prefix + '-updated', reason: ctx.prefix },
      { 'If-Match': String(c.version) },
    );
    await read('update', (x) => x.name === ctx.prefix + '-updated' && x.version === 2);
    await api(
      'contract-activate',
      'POST',
      path + '/activate',
      200,
      { reason: ctx.prefix },
      { 'If-Match': String(c.version) },
    );
    await read('activate', (x) => x.status === 'EFFECTIVE');
    await api('contract-bind', 'POST', path + '/devices/bind', 201, {
      deviceIds: [ctx.devices[0]],
      reason: ctx.prefix,
    });
    const bound = (await api('contract-bound-read', 'GET', path + '/devices', 200)).data;
    proof('contract-bind-persisted', containsActiveContractDevice(bound, ctx.devices[0]));
    await api('contract-unbind', 'POST', path + '/devices/unbind', 200, {
      deviceIds: [ctx.devices[0]],
      reason: ctx.prefix,
    });
    const unbound = (await api('contract-unbound-read', 'GET', path + '/devices', 200)).data;
    proof('contract-unbind-persisted', !containsActiveContractDevice(unbound, ctx.devices[0]));
    await read('before-renew', (x) => x.status === 'EFFECTIVE');
    const newEndAt = new Date(now + 60 * 86400000).toISOString();
    await api(
      'contract-renew',
      'POST',
      path + '/renew',
      200,
      { newEndAt, reason: ctx.prefix },
      { 'If-Match': String(c.version) },
    );
    await read('renew', (x) => Date.parse(x.endAt) === Date.parse(newEndAt));
    await api('contract-evaluate', 'POST', path + '/evaluate', 200, {}, { 'If-Match': String(c.version) });
    await read('evaluate', (x) => x.status === 'EFFECTIVE');
    r.contractId = c.contractId;
    r.browser = await runCloseoutBrowserGaps(ctx, r.contractId);
    await api(
      'contract-terminate',
      'POST',
      path + '/terminate',
      200,
      { reason: ctx.prefix },
      { 'If-Match': String(c.version) },
    );
    await read('terminate', (x) => x.status === 'TERMINATED');

    const originalPath =
      'docs/audit/evidence/qa-09-close-01-2026-10-12/user-target.json.seed-PlatformSuperAdmin.json.preparation.json';
    const bytes = readFileSync(originalPath),
      plan = JSON.parse(bytes).plan;
    if (
      plan.action !== 'business-seed-user' ||
      plan.prefix !== 'qa09-14197706b32ec5b0' ||
      plan.ownUser.role !== 'PlatformSuperAdmin'
    )
      throw Error('EXACT_UNKNOWN_PLAN_REQUIRED');
    r.unknownContainment = {
      originalPlanSha256: createHash('sha256').update(bytes).digest('hex'),
      originalStartGate: 'UNKNOWN',
      restartAllowed: false,
      executionSuccessClaimed: false,
      writes: 0,
      reads: [],
    };
    const own = (await api('historical-user-read', 'GET', '/api/v1/admin/users/' + plan.ownUser.userId, [200, 404]))
      .data;
    if (own) {
      proof(
        'historical-user-exact-scope',
        own.email === plan.ownUser.email &&
          own.roles.length === 1 &&
          own.roles[0] === plan.ownUser.role &&
          own.customerId === null,
      );
      if (own.status !== 'DISABLED') {
        await api(
          'historical-own-user-disable',
          'POST',
          '/api/v1/admin/users/' + plan.ownUser.userId + '/disable',
          200,
          { reason: plan.prefix },
          { 'If-Match': String(own.version) },
        );
        r.unknownContainment.writes++;
      }
      const after = (
        await api('historical-user-disabled-read', 'GET', '/api/v1/admin/users/' + plan.ownUser.userId, 200)
      ).data;
      proof('historical-user-inert', after.status === 'DISABLED' && after.email === plan.ownUser.email);
      r.unknownContainment.businessUser = 'DISABLED_TOMBSTONE';
    } else r.unknownContainment.businessUser = 'ABSENT';
    const cognito = new CognitoIdentityProviderClient({
      region: 'ap-southeast-1',
      credentials: fromIni({ profile: 'esgiot-infra' }),
      maxAttempts: 1,
    });
    try {
      await cognito.send(
        new AdminGetUserCommand({ UserPoolId: 'ap-southeast-1_hZMX8LpFo', Username: plan.ownUser.email }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      throw Error('HISTORICAL_IDENTITY_REMAINS');
    } catch (e) {
      if (e.name !== 'UserNotFoundException') throw e;
      r.unknownContainment.cognitoIdentity = 'ABSENT';
    }
    for (const customer of plan.customers) {
      await api('historical-customer-' + customer.suffix, 'GET', '/api/v1/admin/customers/' + customer.id, 404);
      r.unknownContainment.reads.push({ type: 'customer', absent: true });
    }
    r.unknownContainment.gate = 'PASS_CONTAINMENT_ONLY_UNKNOWN_EXECUTION_PRESERVED';
    r.gate = r.browser.gate === 'PASS' ? 'PASS' : 'FAIL';
  } catch (e) {
    r.gate = 'FAIL';
    r.failureCode = /^[A-Z_]+$/.test(e.message ?? '') ? e.message : 'CLOSEOUT_GAPS_FAILED';
  }
  r.finishedAt = new Date().toISOString();
  ctx.save();
  return r;
}
