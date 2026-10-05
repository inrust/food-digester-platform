import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { runFixture, classifyFixtureCliError } from './qa09-ten-device-bridge.mjs';
import { seedCleanupAction } from './qa09-seed-recovery.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [childFile, output] = process.argv.slice(2);
if (!childFile || !output) throw Error('BUSINESS_OUTPUT_REQUIRED');
const childBytes = readFileSync(childFile),
  child = JSON.parse(childBytes),
  parentBytes = readFileSync(childFile + '.fixtures.json'),
  parent = JSON.parse(parentBytes),
  browser = JSON.parse(readFileSync(childFile + '.browser.json'));
const hash = (b) => createHash('sha256').update(b).digest('hex');
if (
  child.gate !== 'FAIL' ||
  child.cleanupFailure?.code !== 'FIXTURE_BUILD_NOT_VERIFIED' ||
  parent.gate !== 'FAIL' ||
  !/^qa09-[a-f0-9]{16}$/.test(parent.prefix) ||
  child.prefix !== parent.prefix ||
  browser.prefix !== parent.prefix ||
  parent.devices?.length !== 10 ||
  parent.devices.some((id, i) => id !== parent.prefix + '-' + String(i + 1).padStart(2, '0')) ||
  parent.customers?.length !== 2 ||
  parent.customers.some((c, i) => c.name !== parent.prefix + (i ? '-b' : '-a')) ||
  !child.createdSites?.length ||
  child.createdSites.some((s) => !parent.customers.some((c) => c.id === s.customerId)) ||
  browser.exports?.length !== 4 ||
  browser.exports.some((e) => e.kind !== 'esg' || e.result !== 'PASS' || !e.ownRowsVerified)
)
  throw Error('EXACT_FAILED_BUSINESS_LEDGER_REQUIRED');
const seedFile = parent.databaseBuilds.find((b) => b.action === 'business-seed-devices')?.receipt,
  baselineFile = child.databaseBuilds.find((b) => b.action === 'business-baseline')?.receipt;
const seed = JSON.parse(readFileSync(seedFile)),
  baseline = JSON.parse(readFileSync(baselineFile));
if (
  seed.gate !== 'PASS' ||
  baseline.gate !== 'PASS' ||
  seed.result.prefix !== parent.prefix ||
  baseline.result.prefix !== parent.prefix ||
  seed.result.sourceHash !== baseline.result.sourceHash
)
  throw Error('ORIGINAL_BASELINE_BINDING_REQUIRED');
const exports = browser.exports.map((e) => e.id);
function aws(args) {
  const r = spawnSync('aws', [...args, '--profile', 'esgiot-infra', '--region', 'ap-southeast-1', '--output', 'json'], {
    encoding: 'utf8',
    timeout: 150000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw Object.assign(Error('RECOVERY_AWS_READ_FAILED'), { code: classifyFixtureCliError(r.stderr, r.error) });
  return JSON.parse(r.stdout);
}
const r = {
  task: 'QA-09',
  scope: 'FAILED_BUSINESS_EXACT_EXPORT_LEDGER_RECOVERY',
  mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
  target: { accountId: '065986019555', region: 'ap-southeast-1' },
  prefix: parent.prefix,
  sourceCommit: parent.sourceCommit,
  customers: parent.customers,
  devices: parent.devices,
  parentReceiptSha256: hash(parentBytes),
  businessReceiptSha256: hash(childBytes),
  baselineReceiptSha256: hash(readFileSync(baselineFile)),
  seedReceiptSha256: hash(readFileSync(seedFile)),
  semanticExportIds: exports,
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  cleanup: [],
  fullQa09Accepted: false,
  credentialsExported: false,
};
const sources = [
  'scripts/recover-qa09-nonactive-business.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-seed-recovery.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
].map((path) => {
  const b = readFileSync(path);
  return { path, sha256: hash(b), sourceBase64: b.toString('base64') };
});
writeFileSync(output + '.sources.json', JSON.stringify({ task: 'QA-09', sources }, null, 2) + '\n');
r.sourceReceiptSha256 = hash(readFileSync(output + '.sources.json'));
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
let cognito,
  username,
  created = false;
try {
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== '065986019555' || !identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'))
    throw Error('WRONG_RECOVERY_IDENTITY');
  const db = async (action, suffix) =>
    (
      await runFixture(
        {
          prefix: parent.prefix,
          devices: parent.devices,
          customers: parent.customers,
          action,
          baseline: seed.result.originalFingerprints,
          businessBaseline: baseline.result.businessFingerprints,
          semanticExportIds: exports,
        },
        output + '.' + suffix + '.json',
        console.log,
        { logProfile: 'esgiot-infra' },
      )
    ).result;
  const now = await db('business-baseline', 'before');
  r.baselineDifferences = now.businessFingerprints.filter(
    (x, i) => JSON.stringify(x) !== JSON.stringify(baseline.result.businessFingerprints[i]),
  );
  save();
  if (r.baselineDifferences.length) throw Error('RECOVERY_EXTERNAL_BASELINE_DRIFT');
  for (const id of exports) {
    const key = 'esg-exports/' + id + '.csv';
    const versions = aws([
      's3api',
      'list-object-versions',
      '--bucket',
      'fdp-test-raw-065986019555',
      '--prefix',
      key,
      '--no-paginate',
    ]);
    if (versions.IsTruncated || [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].length)
      throw Error('RECOVERY_EXPORT_OBJECT_REMAINS');
    r.cleanup.push({ type: 'esg-object', key, remainingVersions: 0, result: 'PASS' });
  }
  const cleaned = await db('business-cleanup', 'business-cleanup');
  if (Object.values(cleaned.counts).some((n) => n !== 0)) throw Error('RECOVERY_BUSINESS_REMAINS');
  await db('business-audit', 'business-audit');
  r.cleanup.push({ type: 'business-fixtures', result: 'PASS', deleted: cleaned.deleted });
  save();
  const before = await db('observe', 'devices-before');
  if (seedCleanupAction(before, parent.devices) === 'cleanup') await db('cleanup', 'devices-cleanup');
  const after = await db('observe', 'devices-after');
  if (
    after.devices.length ||
    after.certificates.length ||
    after.requests.length ||
    JSON.stringify(after.originalFingerprints) !== JSON.stringify(seed.result.originalFingerprints)
  )
    throw Error('RECOVERY_DATABASE_NOT_EMPTY');
  r.cleanup.push({ type: 'database-fixtures', count: before.devices.length, result: 'PASS' });
  save();
  const creds = aws(['configure', 'export-credentials', '--format', 'process']);
  const credentials = {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
  cognito = new sdk.CognitoIdentityProviderClient({ region: 'ap-southeast-1', credentials, maxAttempts: 1 });
  const pool = 'ap-southeast-1_hZMX8LpFo';
  username = parent.prefix + '-business-recovery-admin@example.invalid';
  const temp = 'A!z9' + randomBytes(24).toString('base64url'),
    password = 'A!z9' + randomBytes(24).toString('base64url');
  await cognito.send(
    new sdk.AdminCreateUserCommand({
      UserPoolId: pool,
      Username: username,
      TemporaryPassword: temp,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  created = true;
  await cognito.send(
    new sdk.AdminAddUserToGroupCommand({ UserPoolId: pool, Username: username, GroupName: 'PlatformSuperAdmin' }),
  );
  const flow = new AuthFlow({
    idp: createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
    userPoolId: pool,
    sessionManager: { establish() {} },
  });
  if ((await flow.login(username, temp)).status !== 'new-password-required') throw Error('RECOVERY_REAL_SRP_REQUIRED');
  const auth = await flow.submitNewPassword(password);
  if (auth.status !== 'authenticated') throw Error('RECOVERY_REAL_SRP_REQUIRED');
  for (const site of child.createdSites) {
    const path = 'https://api.bio-nexa.com/api/v1/admin/sites/' + site.id;
    const headers = { Authorization: 'Bearer ' + auth.session.idToken };
    const get = await fetch(path, { headers, signal: AbortSignal.timeout(20000) });
    if (get.status === 404) {
      r.cleanup.push({ type: 'site', id: site.id, result: 'PASS', alreadyAbsent: true });
      continue;
    }
    if (get.status !== 200) throw Error('RECOVERY_SITE_READ_FAILED');
    const body = await get.json();
    if (!body.data.name.startsWith(parent.prefix) || body.data.customerId !== site.customerId)
      throw Error('RECOVERY_SITE_SCOPE_DRIFT');
    const del = await fetch(path, {
      method: 'DELETE',
      headers: { ...headers, 'If-Match': String(body.data.version) },
      signal: AbortSignal.timeout(20000),
    });
    if (del.status !== 200 || (await fetch(path, { headers, signal: AbortSignal.timeout(20000) })).status !== 404)
      throw Error('RECOVERY_SITE_DELETE_FAILED');
    r.cleanup.push({
      type: 'site',
      id: site.id,
      result: 'PASS',
      gatewayRequestId: del.headers.get('x-amzn-requestid'),
    });
    save();
  }
  for (const c of parent.customers) {
    const path = 'https://api.bio-nexa.com/api/v1/admin/customers/' + c.id;
    const headers = { Authorization: 'Bearer ' + auth.session.idToken };
    const get = await fetch(path, { headers, signal: AbortSignal.timeout(20000) });
    if (get.status === 404) {
      r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS', alreadyAbsent: true });
      continue;
    }
    if (get.status !== 200) throw Error('RECOVERY_CUSTOMER_MISSING');
    const body = await get.json();
    if (body.data.name !== c.name) throw Error('RECOVERY_CUSTOMER_SCOPE_DRIFT');
    const del = await fetch(path, {
      method: 'DELETE',
      headers: { ...headers, 'If-Match': String(body.data.version) },
      signal: AbortSignal.timeout(20000),
    });
    if (del.status !== 200) throw Error('RECOVERY_CUSTOMER_DELETE_FAILED');
    if ((await fetch(path, { headers, signal: AbortSignal.timeout(20000) })).status !== 404)
      throw Error('RECOVERY_CUSTOMER_REMAINS');
    r.cleanup.push({
      type: 'customer',
      id: c.id,
      result: 'PASS',
      gatewayRequestId: del.headers.get('x-amzn-requestid'),
    });
    save();
  }

  r.finishedAt = new Date().toISOString();
  save();
  const closedLedger = output + '.closed-ledger.json';
  writeFileSync(closedLedger, JSON.stringify(r, null, 2) + '\n');
  r.closedLedgerSha256 = hash(readFileSync(closedLedger));
  const domain = await cleanupOwnedDomain(closedLedger, output + '.domain-cleanup.json');
  if (domain.gate !== 'PASS') throw Error('RECOVERY_DOMAIN_CLEANUP_FAILED');
  r.cleanup.push({ type: 'license-domain-archive', result: 'PASS', deleted: domain.deleted.length });
  r.gate = 'PASS';
} catch (e) {
  r.gate = e.code === 'SSO_SESSION_EXPIRED' ? 'BLOCKED' : 'FAIL';
  r.errorCode = /^[A-Z_]+$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'RECOVERY_FAILED';
} finally {
  if (created) {
    try {
      const pool = 'ap-southeast-1_hZMX8LpFo';
      await cognito.send(new sdk.AdminUserGlobalSignOutCommand({ UserPoolId: pool, Username: username }));
      await cognito.send(new sdk.AdminDeleteUserCommand({ UserPoolId: pool, Username: username }));
      let absent = false;
      try {
        await cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: pool, Username: username }));
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      if (!absent) r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: absent ? 'PASS' : 'FAIL' });
    } catch {
      r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: 'FAIL' });
    }
  }
  r.finishedAt = new Date().toISOString();
  r.executorSha256 = hash(readFileSync(new URL(import.meta.url)));
  save();
}
console.log(JSON.stringify({ gate: r.gate, prefix: r.prefix, cleanup: r.cleanup, errorCode: r.errorCode }));
process.exitCode = r.gate === 'PASS' ? 0 : 1;
