import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { callOwnS3Cli } from './qa09-own-s3-cli.mjs';
import { replayGate, exactDuplicateGate, dedupGate, sha256 } from './qa09-reliability-closeout.mjs';
import { uniqueReplayProduction } from './qa09-replay-production-proof.mjs';
import { verifyStartedBuild, STARTED_BUILD_QUERY } from './qa09-started-build-read.mjs';
const exec = promisify(execFile);
export function assertA5RecoveryInputs(parent, r, actor) {
  const job = r.jobs?.[0],
    failures = parent.checks?.filter((c) => c.result !== 'PASS');
  const produced = uniqueReplayProduction(r.production?.rows ?? [], {
    ...r.expected,
    jobId: job?.jobId,
    topicType: 'telemetry',
  });
  if (
    !/^qa09-[a-f0-9]{16}$/.test(parent.prefix ?? '') ||
    r.prefix !== parent.prefix ||
    parent.gate !== 'FAIL' ||
    r.gate !== 'FAIL' ||
    !parent.finishedAt ||
    !r.finishedAt ||
    r.failure ||
    parent.cleanupHold !== 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE' ||
    r.operator?.cleanupHold !== 'UNKNOWN_OPERATOR_CLEANUP_NO_RETRY' ||
    r.operatorCleanup?.gate !== 'FAIL_OR_UNKNOWN_NO_RETRY' ||
    r.businessCleanup !== 'BLOCKED_UNKNOWN_OR_RUNNING_REPLAY' ||
    failures?.length !== 1 ||
    failures[0].id !== 'a5:operator-disabled-readback' ||
    failures[0].method !== 'GET' ||
    failures[0].status !== 404 ||
    !parent.checks.some(
      (c) => c.id === 'a5:operator-disable' && c.method === 'POST' && c.status === 200 && c.result === 'PASS',
    ) ||
    parent.cleanup?.length !== 1 ||
    parent.cleanup[0].type !== 'reliability-write-ownership' ||
    r.jobs?.length !== 1 ||
    !r.operator.realSrp ||
    r.operator.role !== 'PlatformOperator' ||
    r.operator.email !== parent.prefix + '-h01-platformoperator@example.invalid' ||
    actor.gate !== 'PASS_REAL_COGNITO_SUB_TO_OWN_DATABASE_USER' ||
    actor.prefix !== parent.prefix ||
    actor.businessUserId !== r.operator.userId ||
    actor.actorId !== job.requestedBy ||
    actor.applicationCommit !== parent.sourceCommit ||
    JSON.stringify(actor.groups) !== '["PlatformOperator"]' ||
    replayGate(job.view, job.scope) !== 'PASS_NONEMPTY_EXACT_SCOPE_REPLAY' ||
    produced.gate !== 'PASS_UNIQUE_REPLAY_JOB_PRODUCTION' ||
    exactDuplicateGate(r.replayConsumption?.rows ?? [], { ...r.expected, sqsMessageId: produced.sqsMessageId }) !==
      'PASS_EXACT_DUPLICATE_CONSUMPTION' ||
    dedupGate(r.before, r.after) !== 'PASS_NO_RECEIPT_AGGREGATE_OR_ARCHIVE_DUPLICATION' ||
    !['replay.job.create', 'replay.job.execute'].every((action) =>
      r.after.audits?.some((a) => a.object_id === job.jobId && a.action === action && a.result === 'SUCCESS'),
    ) ||
    r.submission?.ssoSendAttempts !== 0 ||
    r.before.devices.some((d) => d.lifecycle_status === 'Active') ||
    r.after.devices.some((d) => d.lifecycle_status === 'Active')
  )
    throw Error('EXACT_TERMINAL_A5_CLEANUP_FAILURE_REQUIRED');
  return job;
}
export function verifyA5RecoveryReceipt(parentPath, recoveryPath) {
  const parent = JSON.parse(readFileSync(parentPath)),
    r = JSON.parse(readFileSync(parentPath + '.reliability.json'));
  const recovery = JSON.parse(readFileSync(recoveryPath));
  if (
    recovery.gate !== 'PASS_RECOVERED_OWN_A5_CLEANUP' ||
    recovery.prefix !== parent.prefix ||
    recovery.parentSha256 !== sha256(readFileSync(parentPath)) ||
    recovery.reliabilitySha256 !== sha256(readFileSync(parentPath + '.reliability.json')) ||
    recovery.sourceSha256 !== sha256(readFileSync(new URL(import.meta.url))) ||
    recovery.bindings.some((b) => b.sha256 !== sha256(readFileSync(b.path))) ||
    recovery.operations.some((o) => o.result !== 'PASS') ||
    recovery.businessCleanup !== 'PASS' ||
    recovery.operatorCleanup?.gate !== 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED' ||
    recovery.operatorCleanup.userId !== r.operator.userId ||
    recovery.operatorCleanup.status !== 'DISABLED' ||
    recovery.operatorCleanup.cognitoDeleted !== true ||
    recovery.originalRootDeleted !== true
  )
    throw Error('BOUND_A5_RECOVERY_RECEIPT_REQUIRED');
  const requiredBindings = [
    parentPath,
    parentPath + '.reliability.json',
    parentPath + '.sources.json',
    recovery.actorPath,
    r.builds.find((b) => b.action === 'business-baseline').receipt,
    recoveryPath + '.sources.json',
    recovery.resourceReceipt,
    recovery.resourceReceipt + '.domain-cleanup.json',
    ...recovery.databaseBuilds.map((b) => b.receipt),
  ];
  if (
    new Set(recovery.bindings.map((b) => b.path)).size !== recovery.bindings.length ||
    requiredBindings.some((path) => !recovery.bindings.some((b) => b.path === path)) ||
    recovery.archiveCleanup?.gate !== 'PASS' ||
    !recovery.finishedAt
  )
    throw Error('COMPLETE_RECOVERY_BINDINGS_REQUIRED');
  const sources = JSON.parse(readFileSync(recoveryPath + '.sources.json')).sources;
  if (
    sources.some((s) => sha256(Buffer.from(s.sourceBase64, 'base64')) !== s.sha256) ||
    sources.find((s) => s.path === 'scripts/recover-qa09-a5-cleanup.mjs')?.sha256 !== recovery.sourceSha256
  )
    throw Error('RECOVERY_SOURCE_DRIFT');
  const actor = JSON.parse(readFileSync(recovery.actorPath));
  assertA5RecoveryInputs(parent, r, actor);
  const generic = JSON.parse(readFileSync(recovery.resourceReceipt));
  if (
    generic.gate !== 'PASS' ||
    generic.prefix !== parent.prefix ||
    generic.parentReceiptSha256 !== recovery.parentSha256 ||
    generic.cleanup.some((c) => c.result !== 'PASS') ||
    generic.cleanup.filter((c) => c.type === 'iot-certificate').length !== 10 ||
    generic.cleanup.filter((c) => c.type === 'iot-thing').length !== 10 ||
    generic.cleanup.filter((c) => c.type === 'customer').length !== 2 ||
    !generic.cleanup.some((c) => c.type === 'database-fixtures' && c.count === 10) ||
    JSON.parse(readFileSync(generic.domainCleanupReceipt)).gate !== 'PASS'
  )
    throw Error('RECOVERED_RESOURCE_CLEANUP_REQUIRED');
  return recovery;
}
export function assertOwnDisableDrift(prior, failed, drift, baseline, parent, r) {
  const old = baseline.result,
    now = drift.result;
  const differences = old.businessFingerprints.filter(
    (f, i) => JSON.stringify(f) !== JSON.stringify(now?.businessFingerprints?.[i]),
  );
  const added = now?.outsideOutboxLedger?.filter((row) => !old.outsideOutboxLedger.some((o) => o.id === row.id));
  if (
    prior.gate !== 'FAIL_OR_UNKNOWN_NO_RETRY' ||
    prior.prefix !== parent.prefix ||
    prior.operatorCleanup?.gate !== 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED' ||
    prior.operatorCleanup.userId !== r.operator.userId ||
    failed.failure?.startedBuildMayStillRun !== false ||
    prior.operations.length !== 3 ||
    prior.operations[0].result !== 'PASS' ||
    prior.operations[1].result !== 'PASS' ||
    prior.operations[2].id !== 'business-cleanup' ||
    prior.operations[2].result !== 'FAIL_OR_UNKNOWN_NO_RETRY' ||
    drift.gate !== 'PASS' ||
    drift.sourceHash !== baseline.sourceHash ||
    differences.length !== 1 ||
    differences[0].table !== 'outbox_events' ||
    added?.length !== 1 ||
    added[0].aggregate_id !== r.operator.userId ||
    added[0].aggregate_type !== 'user' ||
    added[0].event_type !== 'COGNITO_ADMIN_RECONCILIATION' ||
    added[0].status !== 'PUBLISHED' ||
    Number(now.businessFingerprints.find((f) => f.table === 'outbox_events').count) !==
      Number(differences[0].count) + 1 ||
    Number(differences[0].count) !== old.outsideOutboxLedger.length ||
    JSON.stringify(now.outsideOutboxLedger.filter((row) => row.id !== added[0].id)) !==
      JSON.stringify(old.outsideOutboxLedger)
  )
    throw Error('ONLY_EXACT_COMPLETED_OWN_DISABLE_DRIFT_ALLOWED');
  return added[0];
}
export async function recoverA5Cleanup(parentPath, actorPath, output, resumePath, driftPath) {
  if ([output, output + '.sources.json', output + '.resources.json'].some(existsSync))
    throw Error('FRESH_RECOVERY_NO_MUTATION_RETRY_REQUIRED');
  const parent = JSON.parse(readFileSync(parentPath)),
    r = JSON.parse(readFileSync(parentPath + '.reliability.json'));
  const actor = JSON.parse(readFileSync(actorPath)),
    job = assertA5RecoveryInputs(parent, r, actor);
  const baselinePath = r.builds.find((b) => b.action === 'business-baseline').receipt;
  const baseline = JSON.parse(readFileSync(baselinePath));
  const frozen = JSON.parse(readFileSync(parentPath + '.sources.json'));
  if (
    baseline.gate !== 'PASS' ||
    baseline.result.prefix !== parent.prefix ||
    baseline.sourceHash !== frozen.sources.find((s) => s.path === 'scripts/qa09-ten-device-db.mjs').sha256 ||
    (!resumePath && baseline.sourceHash !== sha256(readFileSync('scripts/qa09-ten-device-db.mjs')))
  )
    throw Error('FROZEN_RECOVERY_BASELINE_REQUIRED');
  const paths = [parentPath, parentPath + '.reliability.json', parentPath + '.sources.json', actorPath, baselinePath];
  const prior = resumePath ? JSON.parse(readFileSync(resumePath)) : null;
  const failedPath = resumePath ? resumePath + '.business-cleanup.json' : null;
  const failed = failedPath ? JSON.parse(readFileSync(failedPath)) : null;
  const drift = driftPath ? JSON.parse(readFileSync(driftPath)) : null;
  if (prior) {
    if (
      prior.parentSha256 !== sha256(readFileSync(parentPath)) ||
      prior.reliabilitySha256 !== sha256(readFileSync(parentPath + '.reliability.json'))
    )
      throw Error('RESUME_PARENT_DRIFT');
    assertOwnDisableDrift(prior, failed, drift, baseline, parent, r);
    paths.push(
      resumePath,
      resumePath + '.sources.json',
      failedPath,
      failedPath + '.preparation.json',
      failedPath + '.started.json',
      driftPath,
      driftPath + '.preparation.json',
      driftPath + '.started.json',
    );
  }
  const sources = [
    'scripts/recover-qa09-a5-cleanup.mjs',
    'scripts/recover-qa09-owned-fixtures.mjs',
    'scripts/qa09-ten-device-db.mjs',
    'scripts/qa09-ten-device-bridge.mjs',
    'scripts/qa09-own-s3-cli.mjs',
    'scripts/qa09-owned-domain-cleanup.mjs',
  ].map((path) => {
    const bytes = readFileSync(path);
    return { path, sha256: sha256(bytes), sourceBase64: bytes.toString('base64') };
  });
  writeFileSync(output + '.sources.json', JSON.stringify({ sources }, null, 2) + '\n');
  paths.push(output + '.sources.json');
  const result = {
    scope: 'EXACT_TERMINAL_A5_OPERATOR_READBACK_RECOVERY_NO_NEW_REPLAY',
    prefix: parent.prefix,
    sourceCommit: parent.sourceCommit,
    parentSha256: sha256(readFileSync(parentPath)),
    reliabilitySha256: sha256(readFileSync(parentPath + '.reliability.json')),
    sourceSha256: sha256(readFileSync(new URL(import.meta.url))),
    actorPath,
    startedAt: new Date().toISOString(),
    gate: 'RUNNING',
    operations: [],
    databaseBuilds: [],
    bindings: [],
    fullQa09Accepted: false,
    iamKmsOrCapacityWrites: 0,
    newReplayJobs: 0,
  };
  const save = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  const operate = async (id, fn) => {
    const row = { id, result: 'ATTEMPTING_NO_RETRY' };
    result.operations.push(row);
    save();
    try {
      const value = await fn();
      row.result = 'PASS';
      save();
      return value;
    } catch {
      row.result = 'FAIL_OR_UNKNOWN_NO_RETRY';
      save();
      throw Error('RECOVERY_OPERATION_FAILED_NO_RETRY');
    }
  };
  save();
  const aws = (args) =>
    JSON.parse(
      execFileSync(
        'aws',
        [...args, '--profile', 'esgiot-infra', '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
        { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 },
      ),
    );
  let token;
  try {
    if (aws(['sts', 'get-caller-identity']).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
    if (prior) {
      const prep = JSON.parse(readFileSync(failedPath + '.preparation.json'));
      const observed = verifyStartedBuild(
        aws(['codebuild', 'batch-get-builds', '--ids', failed.build.id, '--query', STARTED_BUILD_QUERY]),
        prep,
        failed.build.id,
      );
      const logs = aws([
        'logs',
        'get-log-events',
        '--log-group-name',
        observed.logs.groupName,
        '--log-stream-name',
        observed.logs.streamName,
        '--start-from-head',
        '--query',
        'events[].message',
      ]);
      const errors = logs
        .flatMap((m) => m.split('\n'))
        .flatMap((m) => {
          try {
            return [JSON.parse(m)];
          } catch {
            return [];
          }
        })
        .filter((e) => e.kind === 'fdp-qa09-fixture-failure/v1');
      if (
        observed.status !== 'FAILED' ||
        errors.length !== 1 ||
        errors[0].errorCode !== 'BUSINESS_BASELINE_DRIFT' ||
        prep.sourceHash !== baseline.sourceHash
      )
        throw Error('FAILED_BUILD_NOT_VERIFIED_ROLLED_BACK');
      result.failedBuilds = [
        {
          id: observed.id,
          status: 'FAILED',
          errorCode: 'BUSINESS_BASELINE_DRIFT',
          rollbackSourceHash: prep.sourceHash,
        },
      ];
      result.resume = {
        path: resumePath,
        sha256: sha256(readFileSync(resumePath)),
        ownDisableOutbox: assertOwnDisableDrift(prior, failed, drift, baseline, parent, r),
      };
      result.databaseBuilds.push({
        action: 'business-baseline-readonly-drift',
        receipt: driftPath,
        buildId: drift.build.id,
      });
      save();
    }
    const ids = [...parent.databaseBuilds, ...r.builds, ...r.fixtureBuilds].map((b) => b.buildId);
    const builds = aws([
      'codebuild',
      'batch-get-builds',
      '--ids',
      ...ids,
      '--query',
      '{builds:builds[].{id:id,status:buildStatus},missing:buildsNotFound}',
    ]);
    if (
      builds.missing.length ||
      builds.builds.length !== ids.length ||
      builds.builds.some((b) => b.status !== 'SUCCEEDED')
    )
      throw Error('EXACT_BUILDS_NOT_TERMINAL');
    result.preflightBuilds = builds.builds;
    save();
    const creds = aws(['configure', 'export-credentials', '--format', 'process']);
    const cognito = new sdk.CognitoIdentityProviderClient({
      region: 'ap-southeast-1',
      maxAttempts: 1,
      credentials: {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
      },
    });
    const pool = 'ap-southeast-1_hZMX8LpFo';
    const call = (Cmd, input) =>
      cognito.send(new Cmd({ UserPoolId: pool, ...input }), { abortSignal: AbortSignal.timeout(20000) });
    const root = parent.prefix + '-platformsuperadmin@example.invalid';
    const readOwnIdentity = async (email, subject) => {
      const u = await call(sdk.AdminGetUserCommand, { Username: email });
      if (
        u.UserAttributes.find((a) => a.Name === 'email')?.Value !== email ||
        u.UserCreateDate.getTime() < Date.parse(parent.startedAt) - 5000 ||
        (subject && u.UserAttributes.find((a) => a.Name === 'sub')?.Value !== subject)
      )
        throw Error('EXACT_OWN_IDENTITY_REQUIRED');
      return u;
    };
    if (parent.identity.username !== root || !parent.identity.created) throw Error('EXACT_ORIGINAL_ROOT_REQUIRED');
    await readOwnIdentity(root);
    const groups = await call(sdk.AdminListGroupsForUserCommand, { Username: root, Limit: 10 });
    if (groups.NextToken || JSON.stringify(groups.Groups.map((g) => g.GroupName)) !== '["PlatformSuperAdmin"]')
      throw Error('EXACT_ROOT_ROLE_REQUIRED');
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    await operate('existing-own-root-password', () =>
      call(sdk.AdminSetUserPasswordCommand, { Username: root, Password: password, Permanent: true }),
    );
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    const auth = await flow.login(root, password);
    if (auth.status !== 'authenticated') throw Error('REAL_RECOVERY_SRP_REQUIRED');
    token = auth.session.idToken;
    const api = async (path) => {
      const response = await fetch('https://api.bio-nexa.com' + path, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(20000),
      });
      if (response.status !== 200) throw Error('RECOVERY_READ_FAILED');
      return response.json();
    };
    const currentJob = (await api('/api/v1/admin/replay/jobs/' + job.jobId)).data;
    if (currentJob.jobId !== job.jobId || replayGate(currentJob, job.scope) !== 'PASS_NONEMPTY_EXACT_SCOPE_REPLAY')
      throw Error('CURRENT_REPLAY_NOT_TERMINAL');
    result.currentJob = currentJob;
    const users = await api(
      '/api/v1/admin/users?status=DISABLED&q=' + encodeURIComponent(r.operator.email) + '&limit=100',
    );
    const user = users.data?.[0];
    if (
      users.meta?.nextCursor ||
      users.data?.length !== 1 ||
      user.userId !== r.operator.userId ||
      user.email !== r.operator.email ||
      user.status !== 'DISABLED' ||
      JSON.stringify(user.roles) !== '["PlatformOperator"]'
    )
      throw Error('OWN_DISABLED_LIST_READBACK_REQUIRED');
    result.disabledReadback = user;
    save();
    async function absent(email) {
      try {
        await call(sdk.AdminGetUserCommand, { Username: email });
        return false;
      } catch (e) {
        if (e.name === 'UserNotFoundException') return true;
        throw e;
      }
    }
    if (!prior) {
      await readOwnIdentity(r.operator.email, actor.actorId);
      await operate('delete-own-operator-cognito', () =>
        call(sdk.AdminDeleteUserCommand, { Username: r.operator.email }),
      );
    }
    if (!(await absent(r.operator.email))) throw Error('OPERATOR_COGNITO_REMAINS');
    result.operatorCleanup = {
      gate: 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED',
      userId: user.userId,
      status: user.status,
      cognitoDeleted: true,
      disablePostRetries: 0,
    };
    save();
    for (const action of ['business-cleanup', 'business-audit']) {
      const path = output + '.' + action + '.json';
      const db = await operate(action, () =>
        runFixture(
          {
            prefix: parent.prefix,
            devices: parent.devices,
            customers: parent.customers,
            action,
            businessBaseline: baseline.result.businessFingerprints,
            ...(prior
              ? { ownDisabledUser: { userId: r.operator.userId, email: r.operator.email, cognitoSub: actor.actorId } }
              : {}),
          },
          path,
          console.log,
        ),
      );
      if (db.gate !== 'PASS' || db.build.status !== 'SUCCEEDED' || Object.values(db.result.counts).some((n) => n !== 0))
        throw Error('BUSINESS_CLEANUP_NOT_VERIFIED');
      result.databaseBuilds.push({ action, receipt: path, buildId: db.build.id });
      paths.push(path);
      save();
    }
    result.businessCleanup = 'PASS';
    save();
    const customerIds = parent.customers.map((c) => c.id),
      prefixes = customerIds.flatMap((id) =>
        ['heartbeat', 'telemetry', 'ack'].map((type) => `raw/topic_type=${type}/customer_id=${id}/`),
      );
    let count = 0;
    for (const prefix of prefixes) {
      const objects = [];
      let key, version;
      do {
        const page = callOwnS3Cli(
          'list-object-versions',
          { Bucket: 'fdp-test-raw-065986019555', Prefix: prefix, KeyMarker: key, VersionIdMarker: version },
          customerIds,
        );
        objects.push(
          ...[...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((o) => ({
            Key: o.Key,
            VersionId: o.VersionId,
          })),
        );
        key = page.IsTruncated ? page.NextKeyMarker : undefined;
        version = page.NextVersionIdMarker;
        if (page.IsTruncated && !key) throw Error('TRUNCATED_ARCHIVE_LIST');
      } while (key);
      for (let i = 0; i < objects.length; i += 1000) {
        const batch = objects.slice(i, i + 1000);
        const deleted = await operate('delete-own-archive-versions-' + count, () =>
          callOwnS3Cli(
            'delete-objects',
            { Bucket: 'fdp-test-raw-065986019555', Delete: { Objects: batch, Quiet: false } },
            customerIds,
          ),
        );
        if (deleted.Errors?.length || deleted.Deleted?.length !== batch.length)
          throw Error('ARCHIVE_DELETE_INCOMPLETE');
        count += batch.length;
      }
      const final = callOwnS3Cli(
        'list-object-versions',
        { Bucket: 'fdp-test-raw-065986019555', Prefix: prefix },
        customerIds,
      );
      if (final.IsTruncated || final.Versions?.length || final.DeleteMarkers?.length)
        throw Error('OWN_ARCHIVE_REMAINS');
    }
    result.archiveCleanup = { gate: 'PASS', versionsDeleted: count, prefixes };
    save();
    result.resourceReceipt = output + '.resources.json';
    save();
    await operate('recover-exact-original-resources', () =>
      exec(
        process.execPath,
        ['--import', 'tsx', 'scripts/recover-qa09-owned-fixtures.mjs', parentPath, result.resourceReceipt],
        { timeout: 1200000, maxBuffer: 1024 * 1024 },
      ),
    );
    const generic = JSON.parse(readFileSync(result.resourceReceipt));
    if (generic.gate !== 'PASS' || JSON.parse(readFileSync(generic.domainCleanupReceipt)).gate !== 'PASS')
      throw Error('RESOURCE_RECOVERY_FAILED');
    paths.push(result.resourceReceipt, generic.domainCleanupReceipt, ...generic.databaseBuilds.map((b) => b.receipt));
    result.databaseBuilds.push(...generic.databaseBuilds);
    save();
    await operate('delete-original-own-root-cognito', () => call(sdk.AdminDeleteUserCommand, { Username: root }));
    if (!(await absent(root))) throw Error('ORIGINAL_ROOT_COGNITO_REMAINS');
    result.originalRootDeleted = true;
    result.recoveryIdentity = generic.recoveryIdentity;
    result.gate = 'PASS_RECOVERED_OWN_A5_CLEANUP';
  } catch (e) {
    result.gate = 'FAIL_OR_UNKNOWN_NO_RETRY';
    result.failure = /^[A-Z_]+$/.test(e.message) ? e.message : 'RECOVERY_FAILED';
  }
  token = undefined;
  result.finishedAt = new Date().toISOString();
  result.bindings = paths.filter(existsSync).map((path) => ({ path, sha256: sha256(readFileSync(path)) }));
  save();
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  recoverA5Cleanup(...process.argv.slice(2)).then((r) => {
    console.log(JSON.stringify({ gate: r.gate, failure: r.failure }));
    process.exitCode = r.gate.startsWith('PASS_') ? 0 : 1;
  });
