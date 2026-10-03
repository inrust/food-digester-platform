import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as s3Sdk from '@aws-sdk/client-s3';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { APP_ROUTES } from '../apps/admin-web/src/router/routes.ts';
import { hasPermission } from '../packages/auth/src/permissions.ts';
import { runTargetLicenseLifecycle } from './qa09-license-lifecycle.mjs';
import { runMqttQuickTarget } from './qa09-mqtt-load-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { CURRENT_TEST_CONFIG } from './qa09-current-environment.mjs';
export const ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
const host = 'https://api.bio-nexa.com';
const pool = 'ap-southeast-1_hZMX8LpFo',
  clientId = '5ljdjsf9g563mc1vdc7vjdjm09';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (v) => createHash('sha256').update(v).digest('hex');
export function assertBusinessContext(r) {
  if (
    !/^qa09-[a-f0-9]{16}$/.test(r.prefix) ||
    r.devices.length !== 10 ||
    r.customers.length !== 2 ||
    r.customers.some(
      (c, i) =>
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.id) ||
        c.name !== `${r.prefix}-${i === 0 ? 'a' : 'b'}`,
    ) ||
    new Set(r.customers.map((c) => c.id)).size !== 2 ||
    r.devices.some((d, i) => d !== `${r.prefix}-${String(i + 1).padStart(2, '0')}`)
  )
    throw Error('OWN_BUSINESS_CONTEXT_REQUIRED');
}
export function validateTargetAssertions(r, stage, required) {
  if (r.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' || !r.finishedAt || r.fullQa09Accepted !== false)
    throw Error('TARGET_EXECUTION_MISSING');
  const rows = r.checks.filter((c) => c.stage === stage);
  if (!rows.length || rows.some((c) => c.result !== 'PASS') || required.some((id) => !rows.some((c) => c.id === id)))
    throw Error('TARGET_REQUIRED_PROOF_MISSING');
  return { stage, assertionsGate: 'PASS', checks: rows.length, sourceCommit: r.sourceCommit, fullQa09Accepted: false };
}
export function validateTargetStage(r, stage, required) {
  if (!r.cleanupComplete) throw Error('TARGET_EXECUTION_OR_CLEANUP_MISSING');
  return { ...validateTargetAssertions(r, stage, required), gate: 'PASS', cleanupVerified: true };
}
export async function runBusinessTarget(
  ctx,
  output,
  { browserOrigin = 'https://admin.bio-nexa.com', coreOnly = false, readDomains = true } = {},
) {
  assertBusinessContext(ctx.receipt);
  const { prefix, devices, customers, sourceCommit } = ctx.receipt;
  const r = {
    task: 'QA-09',
    scope: coreOnly ? 'CORE_BUSINESS_FIVE_ROLE_TARGET' : 'CORE_BUSINESS_FIVE_ROLE_BROWSER_SECURITY_LOAD_TARGET',
    coreOnly,
    readDomainMatrixExecuted: readDomains,
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    sourceCommit,
    prefix,
    devices,
    customers,
    startedAt: new Date().toISOString(),
    checks: [],
    stages: {},
    cleanup: [],
    databaseBuilds: [],
    createdIdentities: [],
    createdSites: [],
    createdExportIds: [],
    gate: 'RUNNING',
    fullQa09Accepted: false,
    credentialsExported: false,
    faultAuthorization: {
      source: 'User confirmed 2026-10-03',
      scope: 'OWN_FIXTURES_ONLY',
      sharedResourcesChanged: false,
    },
    sourceHashes: {},
    sources: [],
  };
  for (const path of [
    'scripts/qa09-business-target.mjs',
    'scripts/qa09-license-lifecycle.mjs',
    'scripts/qa09-ten-device-db.mjs',
    'apps/admin-web/src/router/routes.ts',
    'packages/auth/src/permissions.ts',
    'scripts/qa09-current-environment.mjs',
    'infra/environments/qa09-current-test.json',
  ]) {
    const source = readFileSync(path);
    r.sourceHashes[path] = sha(source);
    r.sources.push({ path, sha256: sha(source), sourceBase64: source.toString('base64') });
  }
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  let stage = 'core';
  const check = (id, ok, data = {}) => {
    r.checks.push({ id, stage, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
    if (!ok) throw Object.assign(Error('TARGET_ASSERTION_FAILED'), { code: id });
  };
  const sessions = new Map([['PlatformSuperAdmin', { idToken: ctx.token, accessToken: ctx.accessToken }]]),
    logins = new Map([['PlatformSuperAdmin', ctx.browserLogin]]),
    created = [],
    sites = [],
    exportIds = [];
  const idp = createCognitoIdpClient({ region: 'ap-southeast-1', clientId });
  const call = (Cmd, input) => ctx.cognito.send(new Cmd(input), { abortSignal: AbortSignal.timeout(30000) });
  const renewals = new Map();
  async function ensureSession(role) {
    if (!role) return;
    const expires = JSON.parse(Buffer.from(sessions.get(role).idToken.split('.')[1], 'base64url')).exp;
    if (expires * 1000 > Date.now() + 120000) return;
    if (!renewals.has(role))
      renewals.set(
        role,
        (async () => {
          const login = logins.get(role);
          const auth =
            role === 'PlatformSuperAdmin'
              ? { status: 'authenticated', session: await ctx.refreshIdentity() }
              : await new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } }).login(
                  login.username,
                  login.password,
                );
          check(role + ':session-renewed', auth.status === 'authenticated');
          sessions.set(role, auth.session);
        })().finally(() => renewals.delete(role)),
      );
    await renewals.get(role);
  }
  async function api(id, role, method, path, expected, body, headers = {}) {
    await ensureSession(role);
    const start = performance.now();
    const res = await fetch(host + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(role ? { Authorization: `Bearer ${sessions.get(role).idToken}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => null);
    check(id, (Array.isArray(expected) ? expected : [expected]).includes(res.status), {
      method,
      path: path.split('?')[0],
      role: role ?? 'anonymous',
      status: res.status,
      expected,
      requestId: data?.meta?.requestId ?? data?.error?.requestId ?? res.headers.get('x-amzn-requestid'),
      errorCode: data?.error?.code ?? null,
      latencyMs: Math.round(performance.now() - start),
    });
    return data;
  }
  async function db(action, businessBaseline, extra = {}) {
    const path = output + `.${action}-${r.databaseBuilds.length}.json`;
    const result = await runFixture(
      {
        prefix,
        devices,
        customers,
        action,
        baseline: ctx.baseline,
        ...extra,
        ...(businessBaseline ? { businessBaseline } : {}),
      },
      path,
      (p) => console.log(p),
    );
    r.databaseBuilds.push({ action, receipt: path, buildId: result.build.id });
    save();
    return result.result;
  }
  let baseline;
  try {
    baseline = (await db('business-baseline')).businessFingerprints;
    for (const role of ROLES) {
      if (role === 'PlatformSuperAdmin') continue;
      const username = `${prefix}-${role.toLowerCase()}@example.invalid`,
        temporary = `A!z9${randomBytes(24).toString('base64url')}`,
        password = `A!z9${randomBytes(24).toString('base64url')}`;
      await call(cognitoSdk.AdminCreateUserCommand, {
        UserPoolId: pool,
        Username: username,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: temporary,
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
          ...(role.startsWith('Customer') ? [{ Name: 'custom:customer_id', Value: customers[0].id }] : []),
        ],
      });
      created.push({ username, role });
      r.createdIdentities.push({ username, role });
      save();
      await call(cognitoSdk.AdminAddUserToGroupCommand, { UserPoolId: pool, Username: username, GroupName: role });
      const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
      check(role + ':challenge', (await flow.login(username, temporary)).status === 'new-password-required');
      const auth = await flow.submitNewPassword(password);
      check(role + ':srp', auth.status === 'authenticated');
      check(
        role + ':scope',
        auth.session.roles.length === 1 &&
          auth.session.roles[0] === role &&
          auth.session.customerId === (role.startsWith('Customer') ? customers[0].id : null),
      );
      sessions.set(role, auth.session);
      logins.set(role, { username, password });
    }
    // Obtain a separate real SRP browser login for the already-created SuperAdmin without changing its password.
    for (const c of customers) {
      const s = await api('site-create-' + c.suffix, 'PlatformSuperAdmin', 'POST', '/api/v1/admin/sites', 201, {
        customerId: c.id,
        name: `${prefix}-site-${c.suffix}`,
        timezone: 'Asia/Shanghai',
      });
      sites.push(s.data);
      r.createdSites.push({ id: s.data.id, customerId: c.id });
      save();
    }
    for (const [i, d] of devices.entries())
      await api(d + ':assignment', 'PlatformSuperAdmin', 'POST', `/api/v1/admin/devices/${d}/assignment`, 200, {
        customerId: customers[i < 5 ? 0 : 1].id,
        siteId: sites[i < 5 ? 0 : 1].id,
        reason: prefix,
      });
    const reads = [
      ['devices', 'device:read', '/devices'],
      ['contracts', 'contract:read', '/contracts'],
      ['licenses', 'license:read', '/licenses'],
      ['configurations', 'config:read', '/configurations'],
      ['device-users', 'device-user:read', '/device-users'],
      ['alarms', 'alarm:read', '/alarms'],
      ['events', 'alarm:read', '/events'],
      ['tamper', 'alarm:read', '/tamper-events'],
      ['dashboard', 'dashboard:read', '/dashboard/overview'],
      ['audit', 'audit:read', '/audit-logs'],
      ['users', 'user:read', '/users'],
      ['settings', 'settings:read', '/settings'],
      ['esg-overview', 'report:read', '/esg/overview'],
      ['esg-hourly', 'report:read', '/esg/hourly'],
      ['esg-daily', 'report:read', '/esg/daily'],
      ['esg-reports', 'report:read', '/esg/reports'],
      ['esg-summary', 'report:read', '/esg/daily-summary'],
      ['esg-versions', 'report:read', '/esg/calculation-versions'],
    ];
    for (const role of ROLES) {
      for (const [name, permission, path] of readDomains ? reads : [])
        await api(
          `${role}:read:${name}`,
          role,
          'GET',
          '/api/v1/admin' + path,
          hasPermission(role, permission) ? 200 : 403,
        );
      for (const [i, d] of [devices[0], devices[5]].entries())
        await api(
          `${role}:device-scope:${i}`,
          role,
          'GET',
          `/api/v1/admin/devices/${d}`,
          i && role.startsWith('Customer') ? 403 : 200,
        );
      if (!hasPermission(role, 'contract:write'))
        await api(role + ':contract-write-denied', role, 'POST', '/api/v1/admin/contracts', 403, {
          contractNumber: prefix + '-denied',
          name: prefix,
          customerId: customers[0].id,
          startAt: new Date(Date.now() - 86400000).toISOString(),
          endAt: new Date(Date.now() + 86400000).toISOString(),
        });
    }
    const now = Date.now(),
      from = new Date(now - 86400000).toISOString(),
      to = new Date(now + 86400000 * 30).toISOString();
    let contract = (
      await api('contract-create', 'PlatformSuperAdmin', 'POST', '/api/v1/admin/contracts', 201, {
        contractNumber: prefix,
        name: prefix,
        customerId: customers[0].id,
        startAt: from,
        endAt: to,
      })
    ).data;
    const cp = '/api/v1/admin/contracts/' + contract.contractId;
    await api('contract-detail', 'PlatformSuperAdmin', 'GET', cp, 200);
    const race = await Promise.all([
      api(
        'contract-race-a',
        'PlatformSuperAdmin',
        'PATCH',
        cp,
        [200, 409],
        { name: prefix + '-race-a', reason: prefix },
        { 'If-Match': String(contract.version) },
      ),
      api(
        'contract-race-b',
        'PlatformSuperAdmin',
        'PATCH',
        cp,
        [200, 409],
        { name: prefix + '-race-b', reason: prefix },
        { 'If-Match': String(contract.version) },
      ),
    ]);
    check(
      'contract-if-match-race',
      r.checks
        .filter((c) => /^contract-race-/.test(c.id))
        .map((c) => c.status)
        .sort()
        .join(',') === '200,409',
    );
    contract = race.find((x) => x?.data)?.data;
    contract = (
      await api(
        'contract-activate',
        'PlatformSuperAdmin',
        'POST',
        cp + '/activate',
        200,
        { reason: prefix },
        { 'If-Match': String(contract.version) },
      )
    ).data;
    await api('contract-bind', 'PlatformSuperAdmin', 'POST', cp + '/devices/bind', 201, {
      deviceIds: [devices[0]],
      reason: prefix,
    });
    await api('contract-devices', 'PlatformSuperAdmin', 'GET', cp + '/devices', 200);
    await api('contract-available', 'PlatformSuperAdmin', 'GET', cp + '/available-devices', 200);
    await api('contract-associations', 'PlatformSuperAdmin', 'GET', cp + '/associations', 200);
    await api('contract-cross-tenant-bind', 'PlatformSuperAdmin', 'POST', cp + '/devices/bind', [400, 403, 404, 409], {
      deviceIds: [devices[1], devices[5]],
      reason: prefix,
    });
    await api('contract-unbind', 'PlatformSuperAdmin', 'POST', cp + '/devices/unbind', 200, {
      deviceIds: [devices[0]],
      reason: prefix,
    });
    contract = (
      await api(
        'contract-renew',
        'PlatformSuperAdmin',
        'POST',
        cp + '/renew',
        200,
        { newEndAt: new Date(now + 86400000 * 60).toISOString(), reason: prefix },
        { 'If-Match': String(contract.version) },
      )
    ).data;
    contract = (
      await api(
        'contract-evaluate',
        'PlatformSuperAdmin',
        'POST',
        cp + '/evaluate',
        200,
        {},
        { 'If-Match': String(contract.version) },
      )
    ).data;
    await api(
      'contract-terminate',
      'PlatformSuperAdmin',
      'POST',
      cp + '/terminate',
      200,
      { reason: prefix },
      { 'If-Match': String(contract.version) },
    );
    r.licenseLifecycle = await runTargetLicenseLifecycle(api, { deviceId: devices[0], from, to, prefix, now });
    check(
      'license-state-sequence-proved',
      r.licenseLifecycle.renewalReplay && r.licenseLifecycle.reactivation === 'Active',
    );
    const config = (
      await api('config-create', 'PlatformOperator', 'POST', '/api/v1/admin/configurations', 201, {
        name: prefix,
        targetDeviceId: devices[0],
      })
    ).data;
    const cfg = '/api/v1/admin/configurations/' + config.configurationId;
    await api('config-detail', 'PlatformOperator', 'GET', cfg, 200);
    const cv = (
      await api('config-version-create', 'PlatformOperator', 'POST', cfg + '/versions', 201, {
        payload: { heartbeatInterval: 60, telemetryInterval: 30, cameraRefreshInterval: 1, temperatureThreshold: 80 },
      })
    ).data;
    await api('config-version-read', 'PlatformOperator', 'GET', cfg + '/versions/' + cv.version, 200);
    await api('config-publish', 'PlatformOperator', 'POST', cfg + '/versions/' + cv.version + '/publish', 200, {});
    await api(
      'config-publish-duplicate',
      'PlatformOperator',
      'POST',
      cfg + '/versions/' + cv.version + '/publish',
      409,
      {},
    );
    await api('config-status', 'PlatformOperator', 'GET', cfg + '/versions/' + cv.version + '/status', 200);
    let du = (
      await api('device-user-create', 'CustomerAdmin', 'POST', '/api/v1/admin/device-users', 201, {
        username: prefix,
        password: `A!z9${randomBytes(20).toString('base64url')}`,
        displayName: prefix,
      })
    ).data;
    const dp = '/api/v1/admin/device-users/' + du.deviceUserId;
    await api('device-user-read', 'CustomerAdmin', 'GET', dp, 200);
    du = (
      await api(
        'device-user-update',
        'CustomerAdmin',
        'PATCH',
        dp,
        200,
        { displayName: prefix + '-updated', reason: prefix },
        { 'If-Match': String(du.version) },
      )
    ).data;
    await api(
      'device-user-assign',
      'CustomerAdmin',
      'POST',
      dp + '/assignments',
      201,
      { deviceIds: [devices[0]], reason: prefix },
      { 'If-Match': String(du.version) },
    );
    du = (await api('device-user-after-assign', 'CustomerAdmin', 'GET', dp, 200)).data;
    await api(
      'device-user-cross-tenant',
      'CustomerAdmin',
      'POST',
      dp + '/assignments',
      409,
      { deviceIds: [devices[5]], reason: prefix },
      { 'If-Match': String(du.version) },
    );
    const afterRejectedAssignment = (await api('device-user-cross-tenant-readback', 'CustomerAdmin', 'GET', dp, 200))
      .data;
    check(
      'device-user-cross-tenant-no-side-effects',
      Array.isArray(du.assignments) &&
        Array.isArray(afterRejectedAssignment.assignments) &&
        afterRejectedAssignment.version === du.version &&
        JSON.stringify(afterRejectedAssignment.assignments) === JSON.stringify(du.assignments),
      { beforeVersion: du.version, afterVersion: afterRejectedAssignment.version },
    );
    await api(
      'device-user-revoke',
      'CustomerAdmin',
      'POST',
      dp + '/assignments/revoke',
      200,
      { deviceIds: [devices[0]], reason: prefix },
      { 'If-Match': String(du.version) },
    );
    du = (await api('device-user-after-revoke', 'CustomerAdmin', 'GET', dp, 200)).data;
    await api(
      'device-user-disable',
      'CustomerAdmin',
      'POST',
      dp + '/disable',
      200,
      { reason: prefix },
      { 'If-Match': String(du.version) },
    );
    const req = (
      await api('consumable-create', 'PlatformSuperAdmin', 'POST', '/api/v1/admin/consumable-requests', 201, {
        deviceId: devices[0],
        consumableType: 'CARBON_FILTER',
        note: prefix,
      })
    ).data;
    const rp = '/api/v1/admin/consumable-requests/' + req.requestId;
    await api('consumable-replay', 'PlatformSuperAdmin', 'POST', '/api/v1/admin/consumable-requests', [200, 201], {
      deviceId: devices[0],
      consumableType: 'CARBON_FILTER',
      note: prefix,
    });
    let cr = (
      await api(
        'consumable-process',
        'PlatformSuperAdmin',
        'POST',
        rp + '/process',
        200,
        { note: prefix },
        { 'If-Match': String(req.version) },
      )
    ).data;
    await api(
      'consumable-complete',
      'PlatformSuperAdmin',
      'POST',
      rp + '/complete',
      200,
      { note: prefix },
      { 'If-Match': String(cr.version) },
    );
    await api(
      'consumable-status-list',
      'PlatformSuperAdmin',
      'GET',
      '/api/v1/admin/consumables?customerId=' + customers[0].id,
      200,
    );
    await api(
      'consumable-contact',
      'CustomerAdmin',
      'GET',
      '/api/v1/admin/consumables/' + devices[0] + '/contact',
      200,
    );
    await api('consumable-request-detail', 'PlatformSuperAdmin', 'GET', rp, 200);
    await api('consumable-request-list', 'CustomerViewer', 'GET', '/api/v1/admin/consumable-requests', 200);
    const cancel = (
      await api('consumable-second-create', 'PlatformSuperAdmin', 'POST', '/api/v1/admin/consumable-requests', 201, {
        deviceId: devices[0],
        consumableType: 'BIO_ADDITIVE',
        note: prefix,
      })
    ).data;
    await api(
      'consumable-cancel',
      'PlatformSuperAdmin',
      'POST',
      '/api/v1/admin/consumable-requests/' + cancel.requestId + '/cancel',
      200,
      { note: prefix },
      { 'If-Match': String(cancel.version) },
    );
    const alarmId = randomUUID();
    await db('business-seed-alarm', undefined, { alarmId });
    const ap = '/api/v1/admin/alarms/' + alarmId;
    await api('alarm-detail', 'PlatformOperator', 'GET', ap, 200);
    await api('alarm-cross-customer', 'CustomerAdmin', 'GET', '/api/v1/admin/alarms/' + randomUUID(), 404);
    await api('alarm-acknowledge', 'PlatformOperator', 'POST', ap + '/acknowledge', 200, { reason: prefix });
    await api('alarm-clear', 'PlatformOperator', 'POST', ap + '/clear', 200, { reason: prefix });
    check('core-workflows-complete', true);
    r.stages.core = 'PASS';
  } catch (e) {
    r.stages.core = 'FAIL';
    r.coreFailure = /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'CORE_TARGET_FAILED';
    save();
  }
  if (!coreOnly) {
    try {
      stage = 'recovery';
      const exp = (
        await api('esg-export-create', 'CustomerAdmin', 'POST', '/api/v1/admin/esg/exports', 202, {
          dataset: 'HOURLY',
          deviceId: devices[0],
        })
      ).data;
      exportIds.push(exp.exportId);
      r.createdExportIds.push(exp.exportId);
      save();
      save();
      const path = '/api/v1/admin/esg/exports/' + exp.exportId;
      let result;
      for (let i = 0; i < 36; i++) {
        result = (await api('esg-export-poll-' + i, 'CustomerAdmin', 'GET', path, 200)).data;
        if (['COMPLETED', 'FAILED'].includes(result.status)) break;
        await pause(5000);
      }
      check('esg-export-completed', result.status === 'COMPLETED', { rowCount: result.rowCount });
      await api('esg-export-viewer-read', 'CustomerViewer', 'GET', path, 200);
      await api('esg-export-viewer-create-denied', 'CustomerViewer', 'POST', '/api/v1/admin/esg/exports', 403, {
        dataset: 'HOURLY',
        deviceId: devices[0],
      });
      if (
        CURRENT_TEST_CONFIG.authorization.ownFixtureFaults?.scope !== 'OWN_CREATED_IDS_ONLY' ||
        !CURRENT_TEST_CONFIG.authorization.ownFixtureFaults.actions.includes('EXPIRED_ESG_EXPORT_LEASE') ||
        CURRENT_TEST_CONFIG.authorization.ownFixtureFaults.sharedResourceChanges !== false
      )
        throw Error('OWN_FAULT_AUTHORIZATION_REQUIRED');
      const changed = await db('business-inject-export-lease', undefined, {
        exportId: exp.exportId,
        faultAuthorization: 'USER_CONFIRMED_OWN_FIXTURE_ONLY_2026_10_03',
      });
      check('own-export-lease-expired', changed.exportLease.expired === true);
      for (let i = 0; i < 36; i++) {
        result = (await api('esg-recovery-poll-' + i, 'CustomerAdmin', 'GET', path, 200)).data;
        if (['COMPLETED', 'FAILED'].includes(result.status)) break;
        await pause(5000);
      }
      check('expired-processing-lease-recovered', result.status === 'COMPLETED');
      const response = await fetch(result.downloadUrl, { signal: AbortSignal.timeout(20000) });
      const csv = await response.text();
      check('esg-export-csv-count', response.status === 200 && csv.trim().split('\n').length - 1 === result.rowCount, {
        rowCount: result.rowCount,
      });
      r.stages.recovery = 'PASS';
    } catch (e) {
      r.stages.recovery = 'FAIL';
      r.recoveryFailure = /^[\w:-]{1,150}$/.test(e.code ?? e.message)
        ? (e.code ?? e.message)
        : 'RECOVERY_TARGET_FAILED';
      save();
    }
    // Independent stages continue even if one core operation fails.
    try {
      stage = 'security';
      const before = await db('business-baseline');
      for (const path of [
        '/api/v1/admin/contracts',
        '/api/v1/admin/licenses',
        '/api/v1/admin/device-users',
        '/api/v1/admin/dashboard/overview',
      ])
        await api('anonymous:' + path, null, 'GET', path, 401);
      for (const body of [
        [],
        { name: prefix, targetDeviceId: devices[0], cloudDomain: 'invalid.example' },
        { name: prefix, targetDeviceId: devices[0], unknown: 1 },
      ])
        await api(
          'invalid-config-' + r.checks.length,
          'PlatformSuperAdmin',
          'POST',
          '/api/v1/admin/configurations',
          400,
          body,
        );
      await api('invite-password-rejected', 'PlatformSuperAdmin', 'POST', '/api/v1/admin/users', 400, {
        email: prefix + '-invalid@example.invalid',
        roles: ['PlatformSuperAdmin'],
        password: 'invalid',
      });
      const after = await db('business-baseline');
      check('invalid-writes-no-business-effects', JSON.stringify(before.counts) === JSON.stringify(after.counts));
      const audit = await api('audit-readback', 'PlatformSuperAdmin', 'GET', '/api/v1/admin/audit-logs?limit=100', 200);
      const raw = JSON.stringify(audit);
      check(
        'audit-no-credential-leak',
        !/-----BEGIN [A-Z ]*PRIVATE KEY|\bBearer [A-Za-z0-9._~-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/.test(raw) &&
          ![...sessions.values()].some((s) => s.idToken && raw.includes(s.idToken)),
      );
      check('security-required-probes-complete', true);
      r.stages.security = 'PASS';
    } catch (e) {
      r.stages.security = 'FAIL';
      r.securityFailure = /^[\w:-]{1,150}$/.test(e.code ?? e.message)
        ? (e.code ?? e.message)
        : 'SECURITY_TARGET_FAILED';
      save();
    }
    try {
      stage = 'browser';
      const { chromium } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
        '@playwright/test',
      );
      const browser = await chromium.launch({ headless: true });
      try {
        for (const role of ROLES) {
          const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
          try {
            const page = await context.newPage();
            const traffic = [];
            page.on('response', (res) => {
              const url = new URL(res.url());
              if (url.origin === host && url.pathname.startsWith('/api/v1/admin/'))
                traffic.push({ path: url.pathname, status: res.status() });
            });
            await page.goto(browserOrigin + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (logins.has(role)) {
              const login = logins.get(role);
              await page.locator('#username').fill(login.username);
              await page.locator('input[type=password]').fill(login.password);
              await page.locator('button[type=submit]').click();
              await page.waitForURL('**/dashboard', { timeout: 45000 });
              await page.getByTestId('dashboard-page').waitFor({ timeout: 30000 });
              check(role + ':browser-srp-login', true);
            } else {
              throw Error('REAL_BROWSER_LOGIN_REQUIRED');
            }

            if (role === 'PlatformSuperAdmin') {
              await page.goto(browserOrigin + '/sites', { waitUntil: 'domcontentloaded' });
              await page.getByTestId('detail-' + sites[0].id).click();
              await page.getByTestId('edit-site').click();
              const form = page.getByTestId('site-form');
              await form.getByLabel('站点名称').fill(prefix + '-browser-updated');
              await form.getByRole('button', { name: '保存', exact: true }).click();
              await page
                .getByTestId('site-detail')
                .filter({ hasText: prefix + '-browser-updated' })
                .waitFor();
              const observed = await api(
                'browser-site-api-readback',
                'PlatformSuperAdmin',
                'GET',
                '/api/v1/admin/sites/' + sites[0].id,
                200,
              );
              check('browser-site-edit-persisted', observed.data.name === prefix + '-browser-updated');
            }
            for (const route of APP_ROUTES.filter(
              (p) => !p.public && !['contract-new', 'contract-detail'].includes(p.pageState),
            )) {
              await page.goto(browserOrigin + route.path, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForLoadState('networkidle', { timeout: 30000 });
              if (route.roles.includes(role)) {
                await page.getByTestId('page-content').waitFor({ timeout: 15000 });
                check(
                  role + ':route:' + route.path,
                  (await page.getByRole('heading', { name: '403', exact: true }).count()) === 0,
                );
              } else {
                await page.getByRole('heading', { name: '403', exact: true }).waitFor({ timeout: 15000 });
                check(role + ':route-denied:' + route.path, true);
              }
            }
            await page.goto(browserOrigin + '/dashboard');
            await page.getByTestId('dashboard-page').waitFor({ timeout: 30000 });
            for (const width of [1440, 375]) {
              await page.setViewportSize({ width, height: 900 });
              await page.waitForTimeout(300);
              const metrics = await page.evaluate(() => ({
                width: innerWidth,
                bodyScroll: document.documentElement.scrollWidth,
                visibleControls: [...document.querySelectorAll('button,input,select')].filter((e) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                }).length,
              }));
              check(role + ':layout:' + width, metrics.bodyScroll <= width + 1 && metrics.visibleControls > 0, {
                metrics,
              });
              const pixels = await page.screenshot({ fullPage: false });
              r.checks.push({
                id: role + ':visual-snapshot:' + width,
                stage,
                result: 'PASS',
                pixelSha256: sha(pixels),
                comparison: 'TARGET_CAPTURE_ONLY_NO_PIXEL_BASELINE',
              });
              save();
            }
            check(role + ':real-api-traffic', traffic.length > 0 && !traffic.some((t) => t.status >= 500), { traffic });
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
      check('browser-required-probes-complete', true);
      r.stages.browser = 'PASS';
    } catch (e) {
      r.stages.browser = 'FAIL';
      r.browserFailure = /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'BROWSER_TARGET_FAILED';
      save();
    }
    try {
      stage = 'httpLoad';
      const samples = [];
      const rounds = 30;
      for (let round = 0; round < rounds; round++) {
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, async (_, i) => {
            const start = performance.now();
            await api(`load:${round}:${i}`, 'PlatformSuperAdmin', 'GET', `/api/v1/admin/devices/${devices[i]}`, 200);
            samples.push(performance.now() - start);
          }),
        );
        if (results.some((result) => result.status === 'rejected')) throw Error('HTTP_LOAD_REQUEST_FAILED');
        await pause(100);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
      check('http-ten-client-load', samples.length === 300, {
        requests: 300,
        concurrency: 10,
        p95Ms: Math.round(p95),
        maxMs: Math.round(samples.at(-1)),
        profile: 'CONTROLLED_HTTP_BURST',
        mqttFullProfileExecuted: false,
      });
      r.stages.httpLoad = 'PASS';
    } catch (e) {
      r.stages.httpLoad = 'FAIL';
      r.httpLoadFailure = /^[\w:-]{1,150}$/.test(e.code ?? e.message)
        ? (e.code ?? e.message)
        : 'HTTP_LOAD_TARGET_FAILED';
      save();
    }
    try {
      stage = 'mqttLoad';
      delete ctx.receipt.archiveKeys;
      ctx.receipt.batchArchiveCleanup = true;
      r.mqttLoad = await runMqttQuickTarget(ctx, db, check, output);
      check('mqtt-load-required-probes-complete', true);
      r.stages.mqttLoad = 'PASS';
      r.stages.load = r.stages.httpLoad === 'PASS' ? 'PASS' : 'FAIL';
    } catch (e) {
      r.stages.load = 'FAIL';
      r.stages.mqttLoad = 'FAIL';
      r.loadFailure = /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'LOAD_TARGET_FAILED';
      save();
    }
  }
  try {
    stage = 'cleanup';
    sessions.set('PlatformSuperAdmin', await ctx.refreshIdentity());
    const s3 = new s3Sdk.S3Client({ region: 'ap-southeast-1', credentials: ctx.credentials, maxAttempts: 1 });
    for (const id of exportIds) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('EXPORT_CLEANUP_SCOPE_DRIFT');
      const key = `esg-exports/${id}.csv`;
      const versions = await s3.send(
        new s3Sdk.ListObjectVersionsCommand({ Bucket: 'fdp-test-export-065986019555', Prefix: key }),
      );
      for (const v of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].filter((v) => v.Key === key))
        await s3.send(
          new s3Sdk.DeleteObjectCommand({ Bucket: 'fdp-test-export-065986019555', Key: key, VersionId: v.VersionId }),
        );
      r.cleanup.push({ type: 'esg-object', key, result: 'PASS' });
      save();
    }
    if (baseline) {
      const cleanup = await db('business-cleanup', baseline);
      check(
        'business-exact-cleanup',
        Object.values(cleanup.counts).every((n) => n === 0),
      );
      const audit = await db('business-audit', baseline);
      check(
        'business-outside-baseline-preserved',
        JSON.stringify(audit.businessFingerprints) === JSON.stringify(baseline),
      );
    }
    for (const site of sites) {
      const path = '/api/v1/admin/sites/' + site.id;
      const found = await api('cleanup-site-read-' + site.id, 'PlatformSuperAdmin', 'GET', path, 200);
      await api('cleanup-site-delete-' + site.id, 'PlatformSuperAdmin', 'DELETE', path, 200, undefined, {
        'If-Match': String(found.data.version),
      });
      await api('cleanup-site-verify-' + site.id, 'PlatformSuperAdmin', 'GET', path, 404);
      r.cleanup.push({ type: 'site', id: site.id, result: 'PASS' });
      save();
    }
  } catch (e) {
    r.cleanupFailure = {
      code: e.code ?? (/^[\w:-]{1,150}$/.test(e.message) ? e.message : 'BUSINESS_CLEANUP_FAILED'),
      errorName: e.name,
      causeCode: e.cause?.code,
    };
    r.cleanup.push({ type: 'business-fixtures', result: 'FAIL' });
    save();
  }
  for (const own of created.reverse()) {
    try {
      const session = sessions.get(own.role);
      let globalSignOut = 'NOT_RUN';
      if (session) {
        try {
          await idp.globalSignOut(session.accessToken);
          globalSignOut = 'PASS';
        } catch {
          globalSignOut = 'FAIL';
        }
      }
      await call(cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: own.username });
      let absent = false;
      try {
        await call(cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: own.username });
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      if (!absent) throw Error('IDENTITY_CLEANUP_NOT_CONFIRMED');
      r.cleanup.push({ type: 'cognito', username: own.username, result: 'PASS', globalSignOut });
    } catch {
      r.cleanup.push({ type: 'cognito', username: own.username, result: 'FAIL' });
    }
    save();
  }
  sessions.clear();
  logins.clear();
  r.cleanupComplete = r.cleanup.every((c) => c.result === 'PASS') && !!baseline;
  r.finishedAt = new Date().toISOString();
  r.gate = Object.values(r.stages).every((s) => s === 'PASS') && r.cleanupComplete ? 'PASS' : 'FAIL';
  r.remainingCoverage = [
    'Full-duration MQTT profile beyond verified quick normal/history/burst',
    'Formal all-operation AWS Gates',
    'Complete Adopt/Adapt prototype behavior bindings and versioned DOM semantic comparison',
    'Settings shared-value concurrency and Media/role-management scenarios',
  ];
  save();
  console.log(
    JSON.stringify({ gate: r.gate, stages: r.stages, checks: r.checks.length, cleanupComplete: r.cleanupComplete }),
  );
  if (!r.cleanupComplete) throw Error('BUSINESS_CLEANUP_FAILED');
  return r;
}
