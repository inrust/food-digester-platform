import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { assertBusinessContext } from './qa09-business-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sha = (b) => createHash('sha256').update(b).digest('hex');
export function validateContractRecovery(child, parent) {
  assertBusinessContext(child);
  const race = child.remaining;
  if (
    child.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
    parent.target?.accountId !== '065986019555' ||
    parent.target.region !== 'ap-southeast-1' ||
    JSON.stringify(child.devices) !== JSON.stringify(parent.devices) ||
    JSON.stringify(child.customers) !== JSON.stringify(parent.customers) ||
    !child.finishedAt ||
    !parent.finishedAt ||
    child.prefix !== parent.prefix ||
    child.sourceCommit !== parent.sourceCommit ||
    child.fullQa09Accepted !== false ||
    child.coreMode !== 'FIVE_ROLE_SCOPE_AND_ASSIGNMENT_FOUNDATION_NOT_FULL_CORE' ||
    race?.scope !== 'OWN_DRAFT_CONTRACT_THREE_CONCURRENT_IF_MATCH_ROUNDS' ||
    race.rounds?.length !== 3 ||
    !/^[a-f0-9-]{36}$/.test(race.contractId ?? '') ||
    child.createdSites?.length !== 2 ||
    child.createdSites.some((s) => !child.customers.some((c) => c.id === s.customerId)) ||
    race.attempts?.length !== 6 ||
    new Set(race.rounds.map((x) => x.round)).size !== 3 ||
    race.rounds.some((x) => ![1, 2, 3].includes(x.round)) ||
    race.attempts.some(
      (a) =>
        !/^[a-f0-9-]{36}$/.test(a.clientRequestId ?? '') ||
        a.state !== 'SETTLED' ||
        a.observation?.result !== 'PASS' ||
        a.observation?.responseReceived !== true,
    ) ||
    new Set(race.attempts.map((a) => a.clientRequestId)).size !== 6 ||
    race.rounds.some(
      (round) =>
        round.settled.join(',') !== 'fulfilled,fulfilled' ||
        round.readback.version !== round.beforeVersion + 1 ||
        round.readback.status !== 'DRAFT',
    ) ||
    race.rounds.some(
      (round) =>
        race.attempts
          .filter((a) => a.round === round.round)
          .map((a) => a.observation?.status)
          .sort()
          .join(',') !== '200,409',
    ) ||
    race.attempts.some((a) => a.observation?.gatewayRequestId !== a.clientRequestId)
  )
    throw Error('EXACT_COMPLETED_CONTRACT_RACE_REQUIRED');
  return race;
}
export async function recover(childFile, output) {
  const childBytes = readFileSync(childFile),
    child = JSON.parse(childBytes);
  const parentBytes = readFileSync(childFile + '.fixtures.json'),
    parent = JSON.parse(parentBytes);
  const race = validateContractRecovery(child, parent);
  const baselineFile = child.databaseBuilds.find((x) => x.action === 'business-baseline').receipt;
  const baselineBytes = readFileSync(baselineFile),
    baseline = JSON.parse(baselineBytes);
  const dbSourceHash = sha(readFileSync(new URL('./qa09-ten-device-db.mjs', import.meta.url)));
  if (baseline.gate !== 'PASS' || baseline.result.prefix !== child.prefix || baseline.sourceHash !== dbSourceHash)
    throw Error('BOUND_BUSINESS_BASELINE_REQUIRED');
  const username = child.prefix + '-contract-recovery@example.invalid',
    pool = 'ap-southeast-1_hZMX8LpFo';
  const r = {
    task: 'QA-09',
    scope: 'READ_ONLY_CONTRACT_AUDIT_COMPLETION_AND_EXACT_CLEANUP',
    mode: parent.mode,
    target: parent.target,
    sourceCommit: child.sourceCommit,
    prefix: child.prefix,
    devices: child.devices,
    customers: child.customers,
    originalChildSha256: sha(childBytes),
    originalParentSha256: sha(parentBytes),
    baselineSha256: sha(baselineBytes),
    startedAt: new Date().toISOString(),
    gate: 'RUNNING',
    cleanup: [],
    checks: [],
    databaseBuilds: [],
    audit: [],
    patchReplay: false,
    fullQa09Accepted: false,
    credentialsExported: false,
    recoveryUsername: username,
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  const proof = (id, ok, data = {}) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
    if (!ok) throw Error('CONTRACT_RECOVERY_ASSERTION_FAILED');
  };
  const paths = [
    'scripts/recover-qa09-contract-race.mjs',
    'scripts/qa09-ten-device-db.mjs',
    'scripts/qa09-ten-device-bridge.mjs',
    'scripts/qa09-owned-domain-cleanup.mjs',
  ];
  writeFileSync(
    output + '.sources.json',
    JSON.stringify(
      {
        sources: paths.map((path) => {
          const b = readFileSync(path);
          return { path, sha256: sha(b), sourceBase64: b.toString('base64') };
        }),
      },
      null,
      2,
    ) + '\n',
  );
  r.sourceReceiptSha256 = sha(readFileSync(output + '.sources.json'));
  save();
  const exported = spawnSync(
    'aws',
    ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (exported.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
  const v = JSON.parse(exported.stdout);
  const cognito = new sdk.CognitoIdentityProviderClient({
    region: 'ap-southeast-1',
    credentials: {
      accessKeyId: v.AccessKeyId,
      secretAccessKey: v.SecretAccessKey,
      sessionToken: v.SessionToken,
    },
    maxAttempts: 1,
  });
  const call = (Cmd, input) => cognito.send(new Cmd(input), { abortSignal: AbortSignal.timeout(45000) });
  const idp = createCognitoIdpClient({
    region: 'ap-southeast-1',
    clientId: '5ljdjsf9g563mc1vdc7vjdjm09',
    fetch: async (operation, payload) => {
      const commands = {
        InitiateAuth: sdk.InitiateAuthCommand,
        RespondToAuthChallenge: sdk.RespondToAuthChallengeCommand,
        GlobalSignOut: sdk.GlobalSignOutCommand,
      };
      if (!commands[operation]) throw Error('RECOVERY_AUTH_OPERATION_FORBIDDEN');
      const reply = await call(commands[operation], payload);
      return { status: 200, body: reply };
    },
  });
  let created = false,
    token;
  const api = async (id, method, path, expected, headers = {}) => {
    const clientRequestId = randomUUID(),
      startedAt = new Date().toISOString();
    const response = await fetch('https://api.bio-nexa.com' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'x-amzn-RequestId': clientRequestId, ...headers },
      signal: AbortSignal.timeout(45000),
    });
    const body = await response.json().catch(() => null);
    proof(id, expected.includes(response.status), {
      method,
      path,
      clientRequestId,
      startedAt,
      status: response.status,
      gatewayRequestId: response.headers.get('x-amzn-requestid'),
      completedAt: new Date().toISOString(),
    });
    return { status: response.status, body };
  };
  const db = async (action) => {
    const path = output + '.' + action + '-' + r.databaseBuilds.length + '.json';
    const b = await runFixture(
      {
        prefix: child.prefix,
        devices: child.devices,
        customers: child.customers,
        action,
        baseline: baseline.result.originalFingerprints,
        businessBaseline: baseline.result.businessFingerprints,
      },
      path,
      console.log,
    );
    r.databaseBuilds.push({ action, receipt: path, buildId: b.build.id });
    save();
    return b.result;
  };
  try {
    const identity = spawnSync('aws', ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const caller = identity.status === 0 ? JSON.parse(identity.stdout) : {};
    proof(
      'exact-test-account-role',
      caller.Account === '065986019555' && caller.Arn?.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'),
    );
    const temp = 'A!z9' + randomBytes(24).toString('base64url'),
      password = 'A!z9' + randomBytes(24).toString('base64url');
    await call(sdk.AdminCreateUserCommand, {
      UserPoolId: pool,
      Username: username,
      MessageAction: 'SUPPRESS',
      TemporaryPassword: temp,
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    created = true;
    save();
    await call(sdk.AdminAddUserToGroupCommand, {
      UserPoolId: pool,
      Username: username,
      GroupName: 'PlatformSuperAdmin',
    });
    const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
    proof('new-identity-srp-challenge', (await flow.login(username, temp)).status === 'new-password-required');
    const auth = await flow.submitNewPassword(password);
    proof('new-identity-real-srp', auth.status === 'authenticated');
    token = auth.session.idToken;
    const list = await api(
      'scoped-audit-list',
      'GET',
      `/api/v1/admin/audit-logs?objectType=contract&objectId=${race.contractId}&action=contract.update&limit=100`,
      [200],
    );
    proof(
      'complete-audit-list',
      !list.body.meta?.nextCursor && list.body.data.filter((x) => x.result === 'SUCCESS').length === 3,
    );
    for (const row of list.body.data.filter((x) => x.result === 'SUCCESS')) {
      proof('own-audit-' + row.auditId, row.objectType === 'contract' && row.objectId === race.contractId);
      const detail = (await api('audit-detail-' + row.auditId, 'GET', '/api/v1/admin/audit-logs/' + row.auditId, [200]))
        .body.data;
      r.audit.push({
        auditId: detail.auditId,
        requestId: detail.requestId,
        beforeVersion: detail.beforeValue?.version,
        afterVersion: detail.afterValue?.version,
        result: detail.result,
      });
      save();
    }
    proof(
      'three-exact-success-audits',
      race.attempts
        .filter((a) => a.observation.status === 200)
        .every(
          (a) =>
            r.audit.filter(
              (b) =>
                b.requestId === a.clientRequestId && b.beforeVersion === a.ifMatch && b.afterVersion === a.ifMatch + 1,
            ).length === 1,
        ),
    );
    proof(
      'no-conflict-success-audit',
      race.attempts
        .filter((a) => a.observation.status === 409)
        .every((a) => !r.audit.some((b) => b.requestId === a.clientRequestId)),
    );
    r.semanticCompletion = 'PASS';
    save();
    const cleaned = await db('business-cleanup');
    proof(
      'business-empty',
      Object.values(cleaned.counts).every((n) => n === 0),
    );
    await db('business-audit');
    r.cleanup.push({ type: 'business-fixtures', result: 'PASS', deleted: cleaned.deleted });
    save();
    const observed = await db('observe');
    if (observed.devices.length) {
      proof('exact-ten-before-delete', observed.devices.length === 10);
      await db('cleanup');
    }
    const after = observed.devices.length ? await db('observe') : observed;
    proof(
      'device-certificate-empty-and-baseline',
      after.devices.length === 0 &&
        after.certificates.length === 0 &&
        after.requests.length === 0 &&
        JSON.stringify(after.originalFingerprints) === JSON.stringify(baseline.result.originalFingerprints),
    );
    r.cleanup.push({
      type: 'database-fixtures',
      count: 10,
      observedAtRecovery: observed.devices.length,
      result: 'PASS',
    });
    save();
    for (const [kind, rows] of [
      ['site', child.createdSites],
      ['customer', child.customers],
    ])
      for (const row of rows) {
        const path = '/api/v1/admin/' + (kind === 'site' ? 'sites' : 'customers') + '/' + row.id;
        const current = await api(kind + '-read-' + row.id, 'GET', path, [200, 404]);
        if (current.status === 200) {
          const data = current.body.data;
          proof(
            kind + '-scope-' + row.id,
            kind === 'site'
              ? data.customerId === row.customerId && data.name.startsWith(child.prefix + '-site-')
              : data.name === row.name,
          );
          await api(kind + '-delete-' + row.id, 'DELETE', path, [200], { 'If-Match': String(data.version) });
        }
        await api(kind + '-absent-' + row.id, 'GET', path, [404]);
        r.cleanup.push({ type: kind, id: row.id, result: 'PASS' });
        save();
      }
    for (const own of [...child.createdIdentities, parent.identity]) {
      proof(
        'own-identity-' + own.username,
        own.username.startsWith(child.prefix + '-') && own.username.endsWith('@example.invalid'),
      );
      let absent = false;
      try {
        await call(sdk.AdminGetUserCommand, { UserPoolId: pool, Username: own.username });
      } catch (e) {
        if (e.name !== 'UserNotFoundException') throw e;
        absent = true;
      }
      if (!absent) {
        await call(sdk.AdminUserGlobalSignOutCommand, { UserPoolId: pool, Username: own.username });
        await call(sdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: own.username });
        try {
          await call(sdk.AdminGetUserCommand, { UserPoolId: pool, Username: own.username });
        } catch (e) {
          if (e.name !== 'UserNotFoundException') throw e;
          absent = true;
        }
      }
      proof('identity-absent-' + own.username, absent);
      r.cleanup.push({ type: 'identity', username: own.username, result: 'PASS' });
      save();
    }
    r.finishedAt = new Date().toISOString();
    save();
    const closed = output + '.closed-ledger.json';
    writeFileSync(closed, JSON.stringify(r, null, 2) + '\n');
    await cleanupOwnedDomain(closed, output + '.domain-cleanup.json');
    r.cleanup.push({ type: 'license-domain-archive', result: 'PASS' });
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.failureCode = /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'CONTRACT_RECOVERY_FAILED';
  } finally {
    if (created)
      try {
        await call(sdk.AdminUserGlobalSignOutCommand, { UserPoolId: pool, Username: username });
        await call(sdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
        let absent = false;
        try {
          await call(sdk.AdminGetUserCommand, { UserPoolId: pool, Username: username });
        } catch (e) {
          absent = e.name === 'UserNotFoundException';
        }
        r.cleanup.push({ type: 'recovery-identity', username, result: absent ? 'PASS' : 'FAIL' });
        if (!absent) r.gate = 'FAIL';
      } catch {
        r.cleanup.push({ type: 'recovery-identity', username, result: 'FAIL' });
        r.gate = 'FAIL';
      }
    token = undefined;
    r.finishedAt = new Date().toISOString();
    save();
  }
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [child, output] = process.argv.slice(2);
  const r = await recover(child, output);
  console.log(
    JSON.stringify({
      gate: r.gate,
      semanticCompletion: r.semanticCompletion,
      cleanup: r.cleanup,
      failureCode: r.failureCode,
    }),
  );
  process.exitCode = r.gate === 'PASS' ? 0 : 1;
}
