import { seedCleanupAction } from './qa09-seed-recovery.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { runBusinessTarget } from './qa09-business-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
import { ROLES } from './qa09-business-target.mjs';
import { legalWriteInventory } from './qa09-legal-write-inventory.mjs';
import { runNonActiveBrowser } from './qa09-nonactive-browser.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
import { validateColdSamplingReceipt } from './qa09-cold409-proof.mjs';
import { runCold409Sampling } from './qa09-cold409-sampling.mjs';
import { runContractRaceTarget } from './qa09-contract-race.mjs';
import { runSecurityRetest } from './qa09-security-retest.mjs';
import { runRemainingNonActive } from './qa09-remaining-nonactive.mjs';
const [output, versionFile, mode] = process.argv.slice(2);
if (mode !== undefined && !['--remaining', '--security-retest', '--contract-race', '--cold409-sampling'].includes(mode))
  throw Error('INVALID_NONACTIVE_MODE');
if (!output || !versionFile) throw Error('OUTPUT_AND_VERSION_REQUIRED');
const version = JSON.parse(readFileSync(versionFile));
validateBusinessVersion(version, version.sourceCommit);
const identity = spawnSync(
  'aws',
  ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--region', 'ap-southeast-1', '--output', 'json'],
  { encoding: 'utf8', timeout: 30000 },
);
if (
  identity.status !== 0 ||
  JSON.parse(identity.stdout).Account !== '065986019555' ||
  !JSON.parse(identity.stdout).Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_')
)
  throw Error('WRONG_AWS_IDENTITY');
const sourcePaths = [
  'scripts/run-qa09-nonactive-target.mjs',
  'scripts/qa09-seed-recovery.mjs',
  'scripts/qa09-business-target.mjs',
  'scripts/qa09-http-observation.mjs',
  'scripts/qa09-https-transport.mjs',
  'packages/database/src/client.ts',
  'packages/database/src/client-preparation.ts',
  'packages/database/src/observed-pg.ts',
  'packages/observability/src/data-path.ts',
  'apps/cloud-api/src/admin/user/service.ts',
  'scripts/qa09-cold409-sampling.mjs',
  'scripts/qa09-cold409-proof.mjs',
  'scripts/qa09-legal-write-inventory.mjs',
  'scripts/qa09-write-boundary-probes.mjs',
  'apps/cloud-api/src/runtime/delivered-operations.ts',
  'scripts/qa09-nonactive-browser.mjs',
  'scripts/qa09-remaining-nonactive.mjs',
  'scripts/qa09-security-retest.mjs',
  'scripts/qa09-contract-race.mjs',
  'scripts/qa09-license-lifecycle.mjs',
  'scripts/qa08-bindings.mjs',
  'contracts/prototype-traceability.yaml',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/check-qa09-business-target.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'scripts/qa09-current-environment.mjs',
  'infra/environments/qa09-current-test.json',
  'apps/admin-web/src/router/routes.ts',
  'packages/auth/src/permissions.ts',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      task: 'QA-09',
      sources: sourcePaths.map((path) => {
        const b = readFileSync(path);
        return { path, sha256: createHash('sha256').update(b).digest('hex'), sourceBase64: b.toString('base64') };
      }),
    },
    null,
    2,
  ) + '\n',
);
const prefix = 'qa09-' + randomBytes(8).toString('hex'),
  devices = Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
const r = {
  task: 'QA-09',
  scope: 'CORE_BUSINESS_REAL_RDS_STATE_FIXTURE',
  mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
  target: { accountId: '065986019555', region: 'ap-southeast-1' },
  fixtureMode: 'REAL_RDS_ONBOARDED_STATE_FOR_BUSINESS_APIS_NO_DEVICE_AUTH_CLAIM',
  prefix,
  devices,
  customers: [],
  checks: [],
  cleanup: [],
  databaseBuilds: [],
  sourceCommit: version.sourceCommit,
  versionReceipt: versionFile,
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  fullQa09Accepted: false,
  credentialsExported: false,
};
const save = () => writeFileSync(output + '.fixtures.json', JSON.stringify(r, null, 2) + '\n');
let cachedCredentials;
const credentials = async () => {
  if (!cachedCredentials || cachedCredentials.expiration.getTime() < Date.now() + 300000) {
    const exported = spawnSync(
      'aws',
      ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (exported.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
    const v = JSON.parse(exported.stdout);
    cachedCredentials = {
      accessKeyId: v.AccessKeyId,
      secretAccessKey: v.SecretAccessKey,
      sessionToken: v.SessionToken,
      expiration: new Date(v.Expiration),
    };
  }
  return cachedCredentials;
};
const region = 'ap-southeast-1',
  pool = 'ap-southeast-1_hZMX8LpFo';
const cognito = new cognitoSdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
const idp = createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' });
const username = prefix + '-platformsuperadmin@example.invalid',
  password = `A!z9${randomBytes(24).toString('base64url')}`;
let created = false,
  seeded = false,
  token,
  accessToken,
  baseline;
const call = (Cmd, input) => cognito.send(new Cmd(input), { abortSignal: AbortSignal.timeout(30000) });
const check = (id, ok, data = {}) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
  save();
  if (!ok) throw Object.assign(Error('CORE_FIXTURE_ASSERTION_FAILED'), { code: id });
};
async function refreshIdentity() {
  const auth = await new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } }).login(
    username,
    password,
  );
  check('dedicated-real-srp-renewal', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  return auth.session;
}
async function api(id, method, path, expected, body, headers = {}) {
  const response = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const v = await response.json().catch(() => null);
  check(id, response.status === expected, {
    method,
    path,
    status: response.status,
    requestId: v?.meta?.requestId ?? v?.error?.requestId ?? response.headers.get('x-amzn-requestid'),
  });
  return v;
}
async function db(action) {
  const path = output + `.fixtures-${action}-${r.databaseBuilds.length}.json`;
  const result = await runFixture(
    { prefix, devices, customers: r.customers, action, ...(baseline ? { baseline } : {}) },
    path,
    (p) => console.log(p),
  );
  r.databaseBuilds.push({ action, receipt: path, buildId: result.build.id });
  save();
  return result.result;
}
save();
try {
  const temporary = `A!z9${randomBytes(24).toString('base64url')}`;
  await call(cognitoSdk.AdminCreateUserCommand, {
    UserPoolId: pool,
    Username: username,
    MessageAction: 'SUPPRESS',
    TemporaryPassword: temporary,
    UserAttributes: [
      { Name: 'email', Value: username },
      { Name: 'email_verified', Value: 'true' },
    ],
  });
  created = true;
  r.identity = { username, created: true };
  save();
  await call(cognitoSdk.AdminAddUserToGroupCommand, {
    UserPoolId: pool,
    Username: username,
    GroupName: 'PlatformSuperAdmin',
  });
  const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
  check('dedicated-first-login-challenge', (await flow.login(username, temporary)).status === 'new-password-required');
  const auth = await flow.submitNewPassword(password);
  check('dedicated-real-srp', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  for (const suffix of ['a', 'b']) {
    const x = await api('create-customer-' + suffix, 'POST', '/api/v1/admin/customers', 201, {
      name: prefix + '-' + suffix,
    });
    r.customers.push({ ...x.data, suffix });
    save();
  }
  const before = await db('observe');
  if (before.devices.length || before.certificates.length || before.requests.length)
    throw Error('UNSEEDED_PREFIX_NOT_EMPTY');
  baseline = before.originalFingerprints;
  seeded = true;
  const seed = await db('business-seed-devices');
  if (JSON.stringify(seed.originalFingerprints) !== JSON.stringify(baseline))
    throw Error('ORIGINAL_BASELINE_CHANGED_DURING_SEED');
  check(
    'real-rds-business-state-fixture',
    seed.fixtureMode === r.fixtureMode &&
      seed.devices.length === 10 &&
      seed.devices.every((d) => d.lifecycle_status === 'Onboarded'),
  );
  await runBusinessTarget(
    {
      receipt: r,
      held: new Map(),
      token,
      accessToken,
      browserLogin: { username, password },
      cognito,
      credentials,
      baseline,
      api,
      refreshIdentity,
    },
    output,
    {
      coreOnly: true,
      readDomains: !['--contract-race', '--cold409-sampling'].includes(mode),
      detailedHttp: ['--contract-race', '--cold409-sampling'].includes(mode),
      nonActiveOnly: true,
      ...(mode !== undefined
        ? {
            foundationOnly: true,
            remainingTarget: async (ctx) =>
              ['--contract-race', '--cold409-sampling'].includes(mode)
                ? await (async () => {
                    const race = await runContractRaceTarget(ctx, {
                      historical: {
                        prefix: 'qa09-0ed30921f63c8541',
                        contractId: '7d95a76b-1b79-42c0-9f64-2c98a9297898',
                        sourceReceiptSha256: '59473f9dbb9288fe2b2933f7bb08c6d187553ac2bf313ccc38ea47b711737e5f',
                      },
                    });
                    if (mode === '--cold409-sampling' && race.gate === 'PASS') {
                      const sample = await runCold409Sampling(ctx);
                      if (sample.gate !== 'PASS') throw Error('COLD_SAMPLING_BUSINESS_INCOMPLETE');
                    }
                    return race;
                  })()
                : mode === '--security-retest'
                  ? runSecurityRetest(ctx)
                  : runRemainingNonActive({ ...ctx, receiptPath: output }),
          }
        : { semanticBrowser: (ctx) => runNonActiveBrowser(ctx, output + '.browser.json') }),
    },
  );
} catch (e) {
  r.gate = 'FAIL';
  r.failure = {
    code: /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'CORE_TARGET_FAILED',
    errorName: e.name,
    causeCode: e.cause?.code,
    httpStatus: e.$metadata?.httpStatusCode,
  };
  save();
} finally {
  if (seeded)
    try {
      const observed = await db('observe');
      const action = seedCleanupAction(observed, devices);
      const result = action === 'cleanup' ? await db(action) : observed;
      check(
        'original-device-certificate-baseline-preserved',
        JSON.stringify(result.originalFingerprints) === JSON.stringify(baseline),
      );
      r.cleanup.push({ type: 'database-fixtures', count: observed.devices.length, result: 'PASS' });
      save();
    } catch {
      r.cleanup.push({ type: 'database-fixtures', result: 'FAIL' });
      save();
    }
  if (created)
    try {
      await refreshIdentity();
    } catch {
      r.cleanup.push({ type: 'identity-renewal', result: 'FAIL' });
      save();
    }
  for (const c of [...r.customers].reverse())
    try {
      const path = '/api/v1/admin/customers/' + c.id;
      const current = await api('cleanup-customer-scope-' + c.suffix, 'GET', path, 200);
      check('own-customer-name-' + c.suffix, current.data.name === prefix + '-' + c.suffix);
      await api('cleanup-customer-' + c.suffix, 'DELETE', path, 200, undefined, {
        'If-Match': String(current.data.version),
      });
      await api('verify-customer-gone-' + c.suffix, 'GET', path, 404);
      r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
      save();
    } catch {
      r.cleanup.push({ type: 'customer', id: c.id, result: 'FAIL' });
      save();
    }
  if (created)
    try {
      if (accessToken) {
        try {
          await idp.globalSignOut(accessToken);
          r.globalSignOut = 'PASS';
        } catch (e) {
          r.globalSignOut = 'FAIL';
          r.globalSignOutErrorName = e.name;
          save();
        }
      }
      await call(cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      let absent = false;
      try {
        await call(cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: username });
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      check('own-superadmin-deleted', absent);
      r.cleanup.push({ type: 'identity', username, result: 'PASS' });
      save();
    } catch {
      r.cleanup.push({ type: 'identity', username, result: 'FAIL' });
      save();
    }
  token = undefined;
  accessToken = undefined;
  r.finishedAt = new Date().toISOString();
  r.gate = r.failure || r.cleanup.some((c) => c.result !== 'PASS') ? 'FAIL' : 'PASS';
  save();
}
let gate = {
  task: 'QA-09',
  scope:
    mode !== undefined
      ? mode === '--cold409-sampling'
        ? 'OWN_BOUNDED_COLD409_SAMPLING'
        : mode === '--contract-race'
          ? 'OWN_CONTRACT_CONCURRENT_PATCH_RETEST'
          : mode === '--security-retest'
            ? 'SCOPED_SECURITY_RESPONSE_RETEST'
            : 'REMAINING_NONACTIVE_LEGAL_WRITES_SECURITY_LEASE_RECOVERY'
      : 'NONACTIVE_LEGAL_WRITES_AND_117_TARGET_BROWSER',
  sourceCommit: r.sourceCommit,
  prefix,
  fullQa09Accepted: false,
  gate: 'FAIL',
};
try {
  const domain = await cleanupOwnedDomain(output + '.fixtures.json', output + '.domain-cleanup.json');
  const child = JSON.parse(readFileSync(output));
  const executed = JSON.parse(readFileSync(output + '.sources.json')).sources;
  const hashes = new Map(
    executed.map((entry) => {
      const digest = createHash('sha256').update(Buffer.from(entry.sourceBase64, 'base64')).digest('hex');
      if (digest !== entry.sha256) throw Error('EXECUTED_SOURCE_BYTES_INVALID');
      return [entry.path, entry.sha256];
    }),
  );
  if (hashes.size !== sourcePaths.length || child.sources.some((entry) => hashes.get(entry.path) !== entry.sha256))
    throw Error('EXECUTED_SOURCE_DRIFT');
  for (const build of r.databaseBuilds) {
    const proof = JSON.parse(readFileSync(build.receipt));
    if (
      proof.gate !== 'PASS' ||
      proof.build.status !== 'SUCCEEDED' ||
      proof.build.id !== build.buildId ||
      proof.build.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' ||
      proof.result.prefix !== prefix ||
      proof.result.action !== build.action ||
      proof.result.sourceHash !== hashes.get('scripts/qa09-ten-device-db.mjs')
    )
      throw Error('CORE_FIXTURE_BUILD_NOT_BOUND');
  }
  if (
    domain.parentReceiptSha256 !==
    createHash('sha256')
      .update(readFileSync(output + '.fixtures.json'))
      .digest('hex')
  )
    throw Error('CORE_DOMAIN_CLEANUP_NOT_BOUND');
  validateBusinessDatabaseReceipts(
    child,
    child.databaseBuilds.map((d) => JSON.parse(readFileSync(d.receipt))),
  );
  writeFileSync(
    output + '.legal-writes.json',
    JSON.stringify(
      { sourceCommit: r.sourceCommit, prefix, operations: legalWriteInventory(child.checks), fullQa09Accepted: false },
      null,
      2,
    ) + '\n',
  );
  if (
    (mode !== undefined
      ? child.stages.foundation !== 'PASS' ||
        child.coreMode !== 'FIVE_ROLE_SCOPE_AND_ASSIGNMENT_FOUNDATION_NOT_FULL_CORE'
      : child.stages.core !== 'PASS') ||
    child.nonActiveOnly !== true ||
    (child.licenseLifecycle?.gate !== 'NOT_RUN' &&
      !(
        mode !== undefined &&
        child.licenseLifecycle === undefined &&
        child.coreMode === 'FIVE_ROLE_SCOPE_AND_ASSIGNMENT_FOUNDATION_NOT_FULL_CORE'
      ))
  )
    throw Error('NONACTIVE_CORE_INCOMPLETE');
  if (mode === '--cold409-sampling') validateColdSamplingReceipt(child);
  if (mode === undefined && (!child.semanticBrowser || child.semanticBrowser.elements.length !== 117))
    throw Error('SEMANTIC_INVENTORY_INCOMPLETE');
  if (mode !== undefined && (!child.remaining || child.remaining.gate !== 'PASS'))
    throw Error('REMAINING_TARGET_INCOMPLETE');
  for (const role of ROLES) {
    const own = child.checks.find((c) => c.id === role + ':device-scope:0'),
      cross = child.checks.find((c) => c.id === role + ':device-scope:1');
    if (own?.status !== 200 || cross?.status !== (role.startsWith('Customer') ? 403 : 200))
      throw Error('FIVE_ROLE_MATRIX_INCOMPLETE');
  }
  if (r.gate !== 'PASS' || domain.gate !== 'PASS') throw Error('CORE_FIXTURE_CLEANUP_INCOMPLETE');
  gate = {
    ...gate,
    gate: mode !== undefined ? 'PASS' : child.semanticBrowser.gate === 'FAIL' ? 'FAIL' : 'PARTIAL',
    checks: child.checks.filter((c) => c.stage === 'core').length,
    cleanup: 'PASS',
    fixtureMode: r.fixtureMode,
    sourceReceipt: output + '.sources.json',
    sourceReceiptSha256: createHash('sha256')
      .update(readFileSync(output + '.sources.json'))
      .digest('hex'),
    ...(mode === '--cold409-sampling' ? { cold409Gate: 'NOT_EVALUATED', maxConcurrency: 6, maxPatchRequests: 12 } : {}),
    remainingCoverage:
      'No real device authentication, natural Active, native browser, full 117 behavior or full QA09 acceptance claim',
  };
} catch (e) {
  gate.reason = /^[A-Z_]+$/.test(e.message) ? e.message : 'CORE_TARGET_PROOF_INCOMPLETE';
}
writeFileSync(output + '.gate.json', JSON.stringify(gate, null, 2) + '\n');
console.log(JSON.stringify(gate));
process.exitCode = ['PASS', 'PARTIAL'].includes(gate.gate) ? 0 : 1;
