import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { validatePlan } from './qa09-ten-device-db.mjs';
import { sha256 } from './qa09-reliability-closeout.mjs';
import { verifyA5RecoveryReceipt } from './recover-qa09-a5-cleanup.mjs';
const exec = promisify(execFile);
export async function collectReliabilityFinal(parentPath, output, recoveryPath) {
  if (existsSync(output)) throw Error('FRESH_FINAL_READ_REQUIRED');
  const parent = JSON.parse(readFileSync(parentPath));
  const recovery = recoveryPath ? verifyA5RecoveryReceipt(parentPath, recoveryPath) : null;
  const ledger = recovery ? JSON.parse(readFileSync(recovery.resourceReceipt)) : parent;
  if (
    !/^qa09-[a-f0-9]{16}$/.test(parent.prefix) ||
    !parent.finishedAt ||
    (!recovery && parent.cleanupHold) ||
    parent.customers?.length !== 2 ||
    ledger.cleanup?.some((c) => c.result !== 'PASS' && c.type !== 'identity-refresh-before-cleanup')
  )
    throw Error('COMPLETED_PARENT_CLEANUP_REQUIRED');
  const frozen = JSON.parse(readFileSync(parentPath + '.sources.json'));
  const mainSource = frozen.sources.find((row) => row.path === 'scripts/run-qa09-ten-device-acceptance.mjs');
  if (
    !mainSource ||
    sha256(Buffer.from(mainSource.sourceBase64, 'base64')) !== parent.executorSha256 ||
    mainSource.sha256 !== parent.executorSha256 ||
    ledger.cleanup.filter((c) => c.type === 'iot-certificate' && c.result === 'PASS').length !== 10 ||
    !ledger.cleanup.some((c) => c.type === 'database-fixtures' && c.count === 10 && c.result === 'PASS') ||
    ledger.cleanup.filter((c) => c.type === 'customer' && c.result === 'PASS').length !== 2 ||
    !ledger.cleanup.some((c) => c.type === 'identity' && c.result === 'PASS') ||
    (recovery
      ? ledger.cleanup.filter((c) => c.type === 'iot-thing' && c.result === 'PASS').length !== 10
      : parent.cleanupOperations.filter((o) => o.operation === 'aws:DeleteThingCommand' && o.result === 'PASS')
          .length !== 10)
  )
    throw Error('BOUND_PARENT_RESOURCE_CLEANUP_REQUIRED');
  const first = JSON.parse(readFileSync(parent.databaseBuilds.find((b) => b.action === 'observe').receipt));
  const plan = {
    prefix: parent.prefix,
    devices: parent.devices,
    customers: parent.customers,
    action: 'audit-empty',
    baseline: first.result.originalFingerprints,
  };
  validatePlan(plan);
  const r = {
    sourceHash: sha256(readFileSync(new URL(import.meta.url))),
    sourceBase64: readFileSync(new URL(import.meta.url)).toString('base64'),
    scope: 'INDEPENDENT_OWN_EMPTY_AND_EXACT_BUILD_TERMINAL_READS',
    prefix: parent.prefix,
    sourceCommit: parent.sourceCommit,
    originalExecutionGate: parent.gate,
    originalCleanupReadFailures: parent.cleanup.filter((c) => c.result !== 'PASS'),
    parentSha256: sha256(readFileSync(parentPath)),
    startedAt: new Date().toISOString(),
    gate: 'RUNNING',
    reads: [],
    identities: [],
    archives: [],
    builds: [],
    failedBuilds: [],
    businessWrites: 0,
    iamKmsOrCapacityWrites: 0,
    fullQa09Accepted: false,
    recovery: recovery ? { path: recoveryPath, sha256: sha256(readFileSync(recoveryPath)), gate: recovery.gate } : null,
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  const read = async (args, allowOwnReaderAbsent = false) => {
    const row = { service: args[0], operation: args[1], result: 'RUNNING' };
    r.reads.push(row);
    save();
    try {
      const response = await exec(
        'aws',
        [
          ...args,
          '--profile',
          'esgiot-infra',
          '--region',
          'ap-southeast-1',
          '--output',
          'json',
          '--no-cli-pager',
          '--cli-connect-timeout',
          '3',
          '--cli-read-timeout',
          '30',
        ],
        { timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
      );
      row.result = 'PASS';
      save();
      return JSON.parse(response.stdout);
    } catch (error) {
      if (
        allowOwnReaderAbsent &&
        args[0] === 'lambda' &&
        args[1] === 'get-function-configuration' &&
        /^fdp-test-qa09-archive-[a-f0-9]{16}$/.test(args[3]) &&
        error.stderr?.includes('ResourceNotFoundException')
      ) {
        row.result = 'PASS';
        row.outcome = 'EXPECTED_NOT_FOUND';
        save();
        return { absent: true };
      }
      row.result = 'FAIL';
      save();
      throw Error('FINAL_READ_FAILED_NO_MUTATION_RETRY');
    }
  };
  try {
    if ((await read(['sts', 'get-caller-identity'])).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
    const dbPath = output + '.audit-empty.json';
    r.databaseReceipt = dbPath;
    r.databaseStart = 'ATTEMPTING_NO_RESTART';
    save();
    const db = await runFixture(plan, dbPath, (msg) => console.log(msg));
    if (db.gate !== 'PASS' || db.result?.prefix !== parent.prefix || db.result?.action !== 'audit-empty')
      throw Error('FINAL_DATABASE_EMPTY_NOT_VERIFIED');
    r.databaseStart = 'COMPLETED';
    r.databaseSha256 = sha256(readFileSync(dbPath));
    save();
    if (parent.archiveReaderReceipt) {
      const reader = JSON.parse(readFileSync(parent.archiveReaderReceipt));
      if (
        reader.gate !== 'PASS' ||
        reader.prefix !== parent.prefix ||
        reader.cleanup.length !== 2 ||
        reader.cleanup.some((r) => r.result !== 'PASS') ||
        sha256(readFileSync(parent.archiveReaderReceipt)) !== parent.archiveReaderSha256 ||
        !/^fdp-test-qa09-archive-[a-f0-9]{16}$/.test(reader.functionName)
      )
        throw Error('BOUND_ARCHIVE_READER_CLEANUP_REQUIRED');
      const absent = await read(['lambda', 'get-function-configuration', '--function-name', reader.functionName], true);
      if (absent?.absent !== true) throw Error('TEMPORARY_ARCHIVE_READER_REMAINS');
      const currentPolicy = await read([
        'iam',
        'get-role-policy',
        '--role-name',
        'fdp-test-replay-role',
        '--policy-name',
        'ReplayFnServiceRoleDefaultPolicy676F95BC',
      ]);
      if (sha256(JSON.stringify(currentPolicy.PolicyDocument)) !== reader.originalRolePolicySha256)
        throw Error('EXISTING_ARCHIVE_ROLE_POLICY_DRIFT');
      r.archiveReader = {
        gate: 'PASS_INDEPENDENTLY_ABSENT_AND_EXISTING_POLICY_UNCHANGED',
        receiptSha256: parent.archiveReaderSha256,
      };
      save();
    }
    const username = parent.prefix + '-platformsuperadmin@example.invalid';
    const users = await read([
      'cognito-idp',
      'list-users',
      '--user-pool-id',
      'ap-southeast-1_hZMX8LpFo',
      '--filter',
      `email = "${username}"`,
      '--limit',
      '1',
      '--no-paginate',
      '--query',
      '{count:length(Users),token:PaginationToken}',
    ]);
    r.identities.push({ username, count: users.count });
    if (users.count !== 0 || users.token) throw Error('OWN_IDENTITY_NOT_EMPTY');
    for (const c of parent.customers)
      for (const type of [
        'heartbeat',
        'telemetry',
        'ack',
        ...['report', 'alarm', 'event', 'tamper'].filter((type) => parent.published.some((p) => p.type === type)),
      ]) {
        const prefix = `raw/topic_type=${type}/customer_id=${c.id}/`;
        const page = await read([
          's3api',
          'list-object-versions',
          '--bucket',
          'fdp-test-raw-065986019555',
          '--prefix',
          prefix,
          '--max-keys',
          '1',
          '--no-paginate',
          '--query',
          '{versions:length(Versions || `[]`),markers:length(DeleteMarkers || `[]`),truncated:IsTruncated}',
        ]);
        r.archives.push({ prefix, ...page });
        save();
        if (page.versions !== 0 || page.markers !== 0 || page.truncated) throw Error('OWN_ARCHIVE_NOT_EMPTY');
      }
    const extension = existsSync(parentPath + '.reliability.json')
      ? JSON.parse(readFileSync(parentPath + '.reliability.json'))
      : { builds: [] };
    if (extension.operator) {
      const own = recovery
        ? { ...extension.operator, businessDisabled: true, cognitoDeleted: true }
        : extension.operator;
      if (
        extension.prefix !== parent.prefix ||
        own.email !== parent.prefix + '-h01-platformoperator@example.invalid' ||
        !/^[a-f0-9-]{36}$/.test(own.userId ?? '') ||
        !own.businessDisabled ||
        !own.cognitoDeleted ||
        (recovery?.operatorCleanup ?? extension.operatorCleanup)?.gate !== 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED'
      )
        throw Error('BOUND_DISABLED_OWN_OPERATOR_REQUIRED');
      const identity = await read([
        'cognito-idp',
        'list-users',
        '--user-pool-id',
        'ap-southeast-1_hZMX8LpFo',
        '--filter',
        `email = "${own.email}"`,
        '--limit',
        '1',
        '--no-paginate',
        '--query',
        '{count:length(Users),token:PaginationToken}',
      ]);
      r.identities.push({ username: own.email, count: identity.count });
      save();
      if (identity.count !== 0 || identity.token) throw Error('OWN_OPERATOR_IDENTITY_NOT_EMPTY');
    }
    if (recovery) {
      const username = recovery.recoveryIdentity.username;
      if (
        username !== ledger.recoveryIdentity.username ||
        !/^qa09-[a-f0-9]{16}-platformsuperadmin@example\.invalid$/.test(username)
      )
        throw Error('BOUND_RECOVERY_IDENTITY_REQUIRED');
      const identity = await read([
        'cognito-idp',
        'list-users',
        '--user-pool-id',
        'ap-southeast-1_hZMX8LpFo',
        '--filter',
        `email = "${username}"`,
        '--limit',
        '1',
        '--no-paginate',
        '--query',
        '{count:length(Users),token:PaginationToken}',
      ]);
      r.identities.push({ username, count: identity.count });
      save();
      if (identity.count !== 0 || identity.token) throw Error('RECOVERY_IDENTITY_NOT_EMPTY');
    }
    if (extension.scope === 'OWN_REAL_MQTT_REPORT_NATURAL_DAILY_AND_EXPORT_LEASE') {
      if (extension.prefix !== parent.prefix || extension.businessCleanup !== 'PASS')
        throw Error('OWN_ESG_CLEANUP_BINDING_REQUIRED');
      r.exportObjects = [];
      for (const job of extension.jobs.filter((j) => j.id)) {
        if (!/^[a-f0-9-]{36}$/.test(job.id)) throw Error('EXACT_EXPORT_LEDGER_REQUIRED');
        const key = 'esg-exports/' + job.id + '.csv';
        const page = await read([
          's3api',
          'list-object-versions',
          '--bucket',
          'fdp-test-export-065986019555',
          '--prefix',
          key,
          '--max-keys',
          '1',
          '--no-paginate',
          '--query',
          '{versions:length(Versions || `[]`),markers:length(DeleteMarkers || `[]`),truncated:IsTruncated}',
        ]);
        r.exportObjects.push({ key, ...page });
        save();
        if (page.versions !== 0 || page.markers !== 0 || page.truncated) throw Error('OWN_EXPORT_OBJECT_NOT_EMPTY');
      }
    }
    const ids = [
      ...parent.databaseBuilds.map((b) => b.buildId),
      ...extension.builds.map((b) => b.buildId),
      ...(extension.fixtureBuilds ?? []).map((b) => b.buildId),
      ...(recovery?.databaseBuilds ?? []).map((b) => b.buildId),
      db.build.id,
    ].filter(Boolean);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^fdp-test-qa09-ten-device-fixtures:[a-f0-9-]{36}$/.test(id))
    )
      throw Error('EXACT_OWN_BUILD_IDS_REQUIRED');
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const response = await read([
        'codebuild',
        'batch-get-builds',
        '--ids',
        ...batch,
        '--query',
        '{builds:builds[].{id:id,status:buildStatus},missing:buildsNotFound}',
      ]);
      if (
        response.missing.length ||
        response.builds.length !== batch.length ||
        new Set(response.builds.map((b) => b.id)).size !== batch.length ||
        response.builds.some((b) => !batch.includes(b.id) || b.status !== 'SUCCEEDED')
      )
        throw Error('OWN_BUILD_NOT_TERMINAL_SUCCEEDED');
      r.builds.push(...response.builds);
      save();
    }
    if (recovery?.failedBuilds?.length) {
      for (const failed of recovery.failedBuilds) {
        if (
          !/^fdp-test-qa09-ten-device-fixtures:[a-f0-9-]{36}$/.test(failed.id) ||
          ids.includes(failed.id) ||
          failed.status !== 'FAILED' ||
          failed.errorCode !== 'BUSINESS_BASELINE_DRIFT'
        )
          throw Error('BOUND_ROLLED_BACK_BUILD_REQUIRED');
        const response = await read([
          'codebuild',
          'batch-get-builds',
          '--ids',
          failed.id,
          '--query',
          '{builds:builds[].{id:id,status:buildStatus,phase:currentPhase},missing:buildsNotFound}',
        ]);
        if (
          response.missing.length ||
          response.builds.length !== 1 ||
          response.builds[0].id !== failed.id ||
          response.builds[0].status !== 'FAILED' ||
          response.builds[0].phase !== 'COMPLETED'
        )
          throw Error('ROLLED_BACK_BUILD_NOT_TERMINAL');
        r.failedBuilds.push({
          ...response.builds[0],
          errorCode: failed.errorCode,
          rollbackSourceHash: failed.rollbackSourceHash,
        });
        save();
      }
    }
    r.gate = 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL';
  } catch (e) {
    r.gate = 'FAIL';
    r.failure = /^[A-Z_]{1,100}$/.test(e.message) ? e.message : 'FINAL_READ_FAILED';
  }
  r.finishedAt = new Date().toISOString();
  save();
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await collectReliabilityFinal(...process.argv.slice(2));
  process.exitCode = result.gate.startsWith('PASS_') ? 0 : 1;
}
