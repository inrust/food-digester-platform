import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as iotSdk from '@aws-sdk/client-iot';
import * as s3Sdk from '@aws-sdk/client-s3';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { assertOwnCloudDevice } from './qa09-ten-device-db.mjs';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { gunzipSync } from 'node:zlib';
import { canonical } from './qa09-archive-probe.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [parentFile, recoveredFile, childFile, output, resumeFile, verifiedPartialFile] = process.argv.slice(2);
const parent = JSON.parse(readFileSync(parentFile)),
  recovered = JSON.parse(readFileSync(recoveredFile)),
  child = JSON.parse(readFileSync(childFile));
const frame = recovered.result;
if (
  !parent.finishedAt ||
  child.cleanupComplete !== false ||
  child.prefix !== parent.prefix ||
  recovered.gate !== 'PASS' ||
  frame.action !== 'observe' ||
  frame.prefix !== parent.prefix ||
  frame.certificates.length !== 10 ||
  frame.devices.length !== 10
)
  throw Error('COMPLETED_OWN_RECOVERY_LEDGER_REQUIRED');
const frozen = JSON.parse(readFileSync(parentFile.replace('.devices.json', '.sources.json'))).sources.find(
  (x) => x.path === 'scripts/qa09-ten-device-db.mjs',
);
if (
  frame.sourceHash !== frozen?.sha256 ||
  frame.buildId !== recovered.build.id ||
  recovered.build.status !== 'SUCCEEDED' ||
  recovered.sourceHash !== frame.sourceHash
)
  throw Error('FROZEN_SOURCE_BUILD_BINDING_REQUIRED');
for (const cert of frame.certificates) assertOwnCloudDevice(cert.device_id, parent.prefix);
const r = {
  task: 'QA-09',
  scope: 'CONTINUATION_OWN_FIXTURE_CLOSURE_AFTER_SSO_EXPIRY',
  sourceCommit: parent.sourceCommit,
  kmsAndIamManagementPerformed: false,
  mode: parent.mode,
  target: parent.target,
  prefix: parent.prefix,
  devices: parent.devices,
  customers: parent.customers,
  startedAt: new Date().toISOString(),
  inputs: [parentFile, recoveredFile, childFile].map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })),
  sourceBase64: readFileSync(new URL(import.meta.url)).toString('base64'),
  recoveryExecutorSources: ['scripts/qa09-ten-device-db.mjs', 'scripts/qa09-ten-device-bridge.mjs'].map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    sourceBase64: readFileSync(path).toString('base64'),
  })),
  cleanup: [],
  checks: [],
  databaseBuilds: [],
  gate: 'RUNNING',
  fullQa09Accepted: false,
  originalExecutionGate: parent.gate,
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
const resume = resumeFile ? JSON.parse(readFileSync(resumeFile)) : null;
if (
  resume &&
  (resume.gate !== 'PASS' ||
    resume.result?.prefix !== parent.prefix ||
    resume.result?.action !== 'cleanup' ||
    resume.result?.deleted?.devices !== 10 ||
    JSON.stringify(resume.result.originalFingerprints) !== JSON.stringify(frame.originalFingerprints))
)
  throw Error('RESUME_CLEANUP_PROOF_REQUIRED');
const verifiedPartial = verifiedPartialFile ? JSON.parse(readFileSync(verifiedPartialFile)) : null;
if (
  verifiedPartial &&
  (verifiedPartial.prefix !== parent.prefix ||
    verifiedPartial.cleanup.length !== 23 ||
    JSON.stringify(verifiedPartial.customers) !== JSON.stringify(parent.customers) ||
    !verifiedPartial.inputs.some(
      (x) => x.path === parentFile && x.sha256 === createHash('sha256').update(readFileSync(parentFile)).digest('hex'),
    ) ||
    verifiedPartial.cleanup.some((x) => x.result !== 'PASS') ||
    verifiedPartial.cleanup.filter((x) => x.type === 'iot-certificate').length !== 10 ||
    verifiedPartial.cleanup.filter((x) => x.type === 'iot-thing').length !== 10)
)
  throw Error('VERIFIED_PARTIAL_CLEANUP_REQUIRED');
if (verifiedPartialFile)
  r.verifiedPartial = {
    path: verifiedPartialFile,
    sha256: createHash('sha256').update(readFileSync(verifiedPartialFile)).digest('hex'),
  };
if (resumeFile)
  r.resumeCleanup = { path: resumeFile, sha256: createHash('sha256').update(readFileSync(resumeFile)).digest('hex') };
let cached;
const credentials = async () => {
  if (!cached || cached.expiration.getTime() < Date.now() + 300000) {
    const x = spawnSync(
      'aws',
      ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (x.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
    const v = JSON.parse(x.stdout);
    cached = {
      accessKeyId: v.AccessKeyId,
      secretAccessKey: v.SecretAccessKey,
      sessionToken: v.SessionToken,
      expiration: new Date(v.Expiration),
    };
  }
  return cached;
};
const region = 'ap-southeast-1',
  iot = new iotSdk.IoTClient({ region, credentials, maxAttempts: 1 }),
  s3 = new s3Sdk.S3Client({ region, credentials, maxAttempts: 1, forcePathStyle: true }),
  cognito = new cognitoSdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
const call = (client, Cmd, input) => {
  if (client !== s3) return client.send(new Cmd(input), { abortSignal: AbortSignal.timeout(120000) });
  const action =
    Cmd === s3Sdk.ListObjectVersionsCommand
      ? 'list-object-versions'
      : Cmd === s3Sdk.DeleteObjectsCommand
        ? 'delete-objects'
        : null;
  if (!action) return client.send(new Cmd(input), { abortSignal: AbortSignal.timeout(60000) });
  const dir = mkdtempSync(join(tmpdir(), 'qa09-s3-cleanup-'));
  try {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify(input));
    let x;
    for (let attempt = 1; attempt <= 3; attempt++) {
      x = spawnSync(
        'aws',
        [
          's3api',
          action,
          '--cli-input-json',
          'file://' + file,
          '--profile',
          action === 'list-object-versions' ? 'esgiot-readonly' : 'esgiot-infra',
          '--region',
          region,
          '--output',
          'json',
          '--no-cli-pager',
          '--no-paginate',
          '--cli-connect-timeout',
          '5',
          '--cli-read-timeout',
          action === 'delete-objects' ? '60' : '180',
        ],
        {
          encoding: 'utf8',
          timeout: action === 'delete-objects' ? 90000 : 240000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, AWS_MAX_ATTEMPTS: action === 'list-object-versions' ? '3' : '1' },
        },
      );
      if (x.status === 0) break;
      const transient = x.stderr?.includes('Read timeout') || x.error?.code === 'ETIMEDOUT';
      r.transportObservations ??= [];
      r.transportObservations.push({
        action,
        attempt,
        transientTimeout: transient,
        submittedVersionCount: input.Delete?.Objects?.length,
      });
      save();
      if (!transient) break;
    }
    if (x.status !== 0)
      throw Object.assign(Error('S3_CLI_FAILED'), {
        code:
          x.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ??
          (x.error?.code === 'ETIMEDOUT' ? 'S3_CLI_TRANSFER_TIMEOUT' : 'S3_CLI_FAILED'),
        cliExitCode: x.status,
        cliSignal: x.signal,
        safeErrorClass:
          [
            'Invalid JSON',
            'Invalid type',
            'Read timeout',
            'Could not connect',
            'SSL validation',
            'No such file',
            'Unknown options',
          ].find((t) => x.stderr?.includes(t)) ?? 'UNCLASSIFIED',
        action,
        safeStderr: x.stderr?.replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 300),
      });
    return x.stdout.trim() ? JSON.parse(x.stdout) : {};
  } finally {
    rmSync(dir, { recursive: true });
  }
};
const pool = 'ap-southeast-1_hZMX8LpFo',
  clientId = '5ljdjsf9g563mc1vdc7vjdjm09',
  username = 'qa09-' + randomBytes(8).toString('hex') + '-recovery@example.invalid',
  idp = createCognitoIdpClient({ region, clientId });
let created = false,
  token,
  accessToken;
const check = (id, ok, data = {}) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
  save();
  if (!ok) throw Error('RECOVERY_ASSERTION_FAILED');
};
async function api(id, method, path, expected, headers = {}) {
  const res = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...headers },
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => null);
  check(id, res.status === expected, { status: res.status, expected, requestId: res.headers.get('x-amzn-requestid') });
  return body;
}
async function db(action, extra = {}) {
  const p = output + '.' + action + '.json';
  const v = await runFixture(
    {
      prefix: r.prefix,
      devices: r.devices,
      customers: r.customers,
      action,
      baseline: frame.originalFingerprints,
      ...extra,
    },
    p,
    console.log,
  );
  r.databaseBuilds.push({ action, receipt: p, buildId: v.build.id });
  save();
  return v.result;
}
try {
  const fixedIdentity = spawnSync(
    'aws',
    ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--region', region, '--output', 'json'],
    { encoding: 'utf8', timeout: 30000 },
  );
  check(
    'fixed-account-role',
    fixedIdentity.status === 0 &&
      JSON.parse(fixedIdentity.stdout).Account === '065986019555' &&
      JSON.parse(fixedIdentity.stdout).Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'),
  );
  const attempts = readFileSync(childFile + '.mqtt-publisher.ndjson', 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const unique = [
    ...new Map(attempts.filter((x) => x.event === 'publish-attempt').map((x) => [x.messageId, x])).values(),
  ];
  const baselinePublished = parent.published.filter((x) => x.seq < 10000);
  check('original-30-baseline-publish-ledger', baselinePublished.length === 30);
  const published = [...baselinePublished, ...unique];
  r.publisherLedgerSha256 = createHash('sha256')
    .update(readFileSync(childFile + '.mqtt-publisher.ndjson'))
    .digest('hex');
  check(
    'quick-original-ledger-count',
    published.length === 950 && new Set(published.map((x) => x.messageId)).size === 950,
  );
  const matched = published.map((p) =>
    frame.receipts.filter((x) => x.device_id === p.deviceId && x.topic_type === p.type && x.seq === p.seq),
  );
  check(
    'quick-950-exact-processed-records',
    matched.every((x) => x.length === 1 && x[0].result === 'PROCESSED'),
    {
      count: matched.filter((x) => x.length === 1 && x[0].result === 'PROCESSED').length,
      extraLaterSloRecords: frame.receipts.length - 950,
    },
  );
  r.mqttLedgerRecovered = {
    unique: published.length,
    telemetry: published.filter((x) => x.type === 'telemetry').length,
    pubacks: attempts.filter((x) => x.event === 'puback').length,
  };
  save();
  r.archiveRecovery = { gate: 'RUNNING', objects: [], matched: [], extraOwnRecords: 0 };
  try {
    if (process.env.QA09_RECOVERED_ARCHIVE_RECEIPT) {
      const path = process.env.QA09_RECOVERED_ARCHIVE_RECEIPT;
      const proof = JSON.parse(readFileSync(path));
      check(
        'external-archive-recovery-binding',
        proof.prefix === r.prefix &&
          ['PASS', 'FAIL'].includes(proof.gate) &&
          proof.plan?.published.length === 950 &&
          proof.plan.published.every((x) =>
            published.some(
              (p) =>
                p.messageId === x.messageId &&
                p.deviceId === x.deviceId &&
                p.bodySha256 === x.bodySha256 &&
                p.payloadSha256 === x.payloadSha256,
            ),
          ) &&
          proof.cleanup.every((x) => x.result === 'PASS') &&
          (proof.gate !== 'PASS' || proof.result?.allTelemetryArchived === true),
      );
      r.archiveRecovery = {
        gate: proof.gate === 'PASS' ? 'PASS_EXACT_920_ORIGINAL_BYTES' : 'NOT_RUN_NO_ORIGINAL_BYTES_RECEIPT',
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        archivedMessages: proof.result?.archivedMessages,
        originalReadGate: proof.gate,
        originalReadError: proof.awsCode ?? proof.errorCode,
        deadlineAt: proof.plan.archiveDeadlineAt,
      };
    } else {
      const deadline = new Date(
        Math.max(...attempts.filter((x) => x.event === 'puback').map((x) => Date.parse(x.acknowledgedAt))) + 300000,
      ).toISOString();
      r.archiveRecovery.deadlineAt = deadline;
      const keys = [];
      for (const c of r.customers)
        for (const type of ['heartbeat', 'telemetry']) {
          let token;
          do {
            const page = await call(s3, s3Sdk.ListObjectsV2Command, {
              Bucket: 'fdp-test-raw-065986019555',
              Prefix: `raw/topic_type=${type}/customer_id=${c.id}/`,
              ContinuationToken: token,
            });
            keys.push(...(page.Contents ?? []).map((x) => x.Key));
            if (keys.length > 4000) throw Error('ARCHIVE_LIMIT');
            token = page.NextContinuationToken;
          } while (token);
        }
      let offset = 0;
      const matchedIds = new Set();
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          while (offset < keys.length) {
            const key = keys[offset++];
            const v = await call(s3, s3Sdk.GetObjectCommand, { Bucket: 'fdp-test-raw-065986019555', Key: key });
            if (v.ContentLength > 1048576) throw Error('ARCHIVE_LIMIT');
            const bytes = Buffer.from(await v.Body.transformToByteArray());
            const lines = gunzipSync(bytes, { maxOutputLength: 4194304 }).toString().trim().split('\n').map(JSON.parse);
            r.archiveRecovery.objects.push({
              key,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              lastModified: v.LastModified.toISOString(),
              records: lines.length,
            });
            for (const line of lines) {
              assertOwnCloudDevice(line.deviceId, r.prefix);
              const p = published.find((x) => x.deviceId === line.deviceId && x.messageId === line.messageId);
              if (!p) {
                r.archiveRecovery.extraOwnRecords++;
                continue;
              }
              const row = frame.outbox.find((x) => x.id === line.eventId);
              const bodySha = createHash('sha256').update(line.rawBody).digest('hex');
              const payloadSha = createHash('sha256').update(canonical(line.payload)).digest('hex');
              if (
                !row ||
                row.rawBodySha256 !== bodySha ||
                bodySha !== p.bodySha256 ||
                payloadSha !== p.payloadSha256 ||
                matchedIds.has(line.messageId)
              )
                throw Error('ARCHIVE_LEDGER_MISMATCH');
              matchedIds.add(line.messageId);
              r.archiveRecovery.matched.push({
                messageId: line.messageId,
                eventId: line.eventId,
                type: p.type,
                bodySha256: bodySha,
                payloadSha256: payloadSha,
                withinDeadline: Date.parse(v.LastModified) <= Date.parse(deadline),
              });
            }
          }
        }),
      );
      const tele = published.filter((x) => x.type === 'telemetry');
      if (!tele.every((x) => matchedIds.has(x.messageId))) throw Error('TELEMETRY_ARCHIVE_MISSING');
      r.archiveRecovery.gate = 'PASS_EXACT_920_ORIGINAL_BYTES';
      r.archiveRecovery.archivedTelemetry = tele.length;
      r.archiveRecovery.deadlineGate = r.archiveRecovery.matched.every((x) => x.withinDeadline) ? 'PASS' : 'FAIL';
    }
  } catch (e) {
    r.archiveRecovery.gate = 'FAIL';
    r.archiveRecovery.errorName = e.name;
    r.archiveRecovery.errorCode = /^[A-Z_]+$/.test(e.message) ? e.message : 'ARCHIVE_RECOVERY_FAILED';
  }
  save();
  const baselineReceiptPath =
    process.env.QA09_RECOVERY_BUSINESS_BASELINE ??
    child.databaseBuilds.find((x) => x.action === 'business-baseline').receipt;
  const businessBaselineReceipt = JSON.parse(readFileSync(baselineReceiptPath));
  check(
    'business-cleanup-current-source-baseline',
    businessBaselineReceipt.gate === 'PASS' &&
      businessBaselineReceipt.result?.prefix === r.prefix &&
      businessBaselineReceipt.result.action === 'business-baseline' &&
      [
        child.sourceHashes['scripts/qa09-ten-device-db.mjs'],
        createHash('sha256').update(readFileSync('scripts/qa09-ten-device-db.mjs')).digest('hex'),
      ].includes(businessBaselineReceipt.sourceHash) &&
      businessBaselineReceipt.build.status === 'SUCCEEDED',
  );
  r.cleanupScopeBaseline = {
    path: baselineReceiptPath,
    sha256: createHash('sha256').update(readFileSync(baselineReceiptPath)).digest('hex'),
    originalBaselinePath: child.databaseBuilds.find((x) => x.action === 'business-baseline').receipt,
    scopeCorrection: 'OWN_DEVICE_CONFIGURATION_AND_VERSION_AGGREGATE_OUTBOX_INCLUDED',
  };
  const businessBaseline = businessBaselineReceipt.result.businessFingerprints;
  if (verifiedPartial) {
    for (const action of ['business-cleanup', 'business-audit']) {
      const past = verifiedPartial.databaseBuilds.find((x) => x.action === action);
      const v = JSON.parse(readFileSync(past.receipt));
      check(
        'resumed-' + action + '-verified',
        v.gate === 'PASS' &&
          v.build.status === 'SUCCEEDED' &&
          v.result.prefix === r.prefix &&
          v.result.action === action &&
          Object.values(v.result.counts).every((n) => n === 0) &&
          JSON.stringify(v.result.businessFingerprints) === JSON.stringify(businessBaseline),
      );
      r.databaseBuilds.push({ ...past, resumed: true });
    }
  } else {
    const clearedBusiness = await db('business-cleanup', { businessBaseline });
    check(
      'business-counts-zero',
      Object.values(clearedBusiness.counts).every((x) => x === 0),
    );
    const businessAudit = await db('business-audit', { businessBaseline });
    check(
      'outside-business-baseline-preserved',
      JSON.stringify(businessAudit.businessFingerprints) === JSON.stringify(businessBaseline),
    );
    r.cleanup.push({ type: 'business-fixtures', result: 'PASS' });
    save();
  }
  for (const id of child.createdExportIds) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('EXPORT_LEDGER_REQUIRED');
    const key = `esg-exports/${id}.csv`,
      bucket = 'fdp-test-export-065986019555';
    const versions = await call(s3, s3Sdk.ListObjectVersionsCommand, { Bucket: bucket, Prefix: key });
    if (
      versions.IsTruncated ||
      [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].some((x) => x.Key !== key)
    )
      throw Error('EXPORT_SCOPE_DRIFT');
    const owned = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map((x) => ({
      Key: x.Key,
      VersionId: x.VersionId,
    }));
    if (owned.length) {
      const result = await call(s3, s3Sdk.DeleteObjectsCommand, { Bucket: bucket, Delete: { Objects: owned } });
      check('export-version-delete-' + id, !result.Errors?.length && result.Deleted?.length === owned.length);
    }
    const absent = await call(s3, s3Sdk.ListObjectVersionsCommand, { Bucket: bucket, Prefix: key });
    check(
      'export-all-versions-absent-' + id,
      !absent.Versions?.length && !absent.DeleteMarkers?.length && !absent.IsTruncated,
    );
    r.cleanup.push({ type: 'esg-object', key, result: 'PASS' });
    save();
  }
  if (!resume) {
    for (const cert of frame.certificates) {
      const arn = `arn:aws:iot:${region}:065986019555:cert/${cert.id}`;
      const things = await call(iot, iotSdk.ListPrincipalThingsCommand, { principal: arn });
      check(
        'certificate-own-things-' + cert.id,
        (things.things ?? []).every((x) => r.devices.includes(x)),
      );
      await call(iot, iotSdk.UpdateCertificateCommand, { certificateId: cert.id, newStatus: 'INACTIVE' });
      for (const thing of things.things ?? [])
        await call(iot, iotSdk.DetachThingPrincipalCommand, { thingName: thing, principal: arn });
      const policies = await call(iot, iotSdk.ListAttachedPoliciesCommand, { target: arn });
      check(
        'certificate-own-policies-' + cert.id,
        (policies.policies ?? []).every((x) => x.policyName === 'fdp-device-' + cert.device_id),
      );
      for (const p of policies.policies ?? []) {
        await call(iot, iotSdk.DetachPolicyCommand, { policyName: p.policyName, target: arn });
        await call(iot, iotSdk.DeletePolicyCommand, { policyName: p.policyName });
      }
      await call(iot, iotSdk.DeleteCertificateCommand, { certificateId: cert.id });
      r.cleanup.push({ type: 'iot-certificate', id: cert.id, result: 'PASS' });
      save();
    }
    for (const id of r.devices) {
      await call(iot, iotSdk.DeleteThingCommand, { thingName: id });
      r.cleanup.push({ type: 'iot-thing', id, result: 'PASS' });
      save();
    }
    const cleared = await db('cleanup');
    check('ten-database-fixtures-deleted', cleared.deleted.devices === 10);
    r.cleanup.push({ type: 'database-fixtures', count: 10, result: 'PASS' });
    save();
  } else if (verifiedPartial) {
    r.cleanup = verifiedPartial.cleanup;
    r.databaseBuilds.push({ action: 'cleanup', receipt: resumeFile, buildId: resume.build.id });
    save();
  } else {
    for (const cert of frame.certificates) {
      const absent = await call(iot, iotSdk.DescribeCertificateCommand, { certificateId: cert.id }).then(
        () => false,
        (e) => e.name === 'ResourceNotFoundException',
      );
      check('certificate-absent-' + cert.id, absent);
      r.cleanup.push({ type: 'iot-certificate', id: cert.id, result: 'PASS' });
    }
    for (const id of r.devices) {
      const absent = await call(iot, iotSdk.DescribeThingCommand, { thingName: id }).then(
        () => false,
        (e) => e.name === 'ResourceNotFoundException',
      );
      check('thing-absent-' + id, absent);
      r.cleanup.push({ type: 'iot-thing', id, result: 'PASS' });
    }
    r.cleanup.push({ type: 'database-fixtures', count: 10, result: 'PASS' });
    r.databaseBuilds.push({ action: 'cleanup', receipt: resumeFile, buildId: resume.build.id });
    save();
  }
  const owned = [];
  for (const c of r.customers)
    for (const type of ['heartbeat', 'telemetry', 'ack']) {
      const prefix = `raw/topic_type=${type}/customer_id=${c.id}/`;
      let key, version;
      do {
        const page = await call(s3, s3Sdk.ListObjectVersionsCommand, {
          Bucket: 'fdp-test-raw-065986019555',
          Prefix: prefix,
          MaxKeys: 200,
          KeyMarker: key,
          ...(version ? { VersionIdMarker: version } : {}),
        });
        for (const v of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
          if (!v.Key.startsWith(prefix)) throw Error('ARCHIVE_SCOPE_DRIFT');
          owned.push({ Key: v.Key, VersionId: v.VersionId });
        }
        key = page.IsTruncated ? page.NextKeyMarker : undefined;
        version = page.NextVersionIdMarker;
      } while (key);
    }
  for (let i = 0; i < owned.length; i += 500) {
    const v = await call(s3, s3Sdk.DeleteObjectsCommand, {
      Bucket: 'fdp-test-raw-065986019555',
      Delete: { Objects: owned.slice(i, i + 500), Quiet: true },
    });
    check('raw-delete-batch-' + i, !v.Errors?.length, {
      submittedVersions: owned.slice(i, i + 500).length,
      quietResponse: true,
      mandatoryCompleteReadback: true,
    });
  }
  for (const c of r.customers)
    for (const type of ['heartbeat', 'telemetry', 'ack']) {
      const v = await call(s3, s3Sdk.ListObjectVersionsCommand, {
        Bucket: 'fdp-test-raw-065986019555',
        Prefix: `raw/topic_type=${type}/customer_id=${c.id}/`,
      });
      check('raw-absent-' + c.suffix + '-' + type, !v.Versions?.length && !v.DeleteMarkers?.length && !v.IsTruncated);
    }
  r.cleanup.push({ type: 'archive-batch-owned-prefix', count: owned.length, result: 'PASS' });
  save();
  const temporary = 'A!z9' + randomBytes(24).toString('base64url'),
    password = 'A!z9' + randomBytes(24).toString('base64url');
  await call(cognito, cognitoSdk.AdminCreateUserCommand, {
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
  r.recoveryIdentity = { username };
  save();
  await call(cognito, cognitoSdk.AdminAddUserToGroupCommand, {
    UserPoolId: pool,
    Username: username,
    GroupName: 'PlatformSuperAdmin',
  });
  const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
  check('first-challenge', (await flow.login(username, temporary)).status === 'new-password-required');
  const auth = await flow.submitNewPassword(password);
  check('actual-srp', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  for (const site of child.createdSites) {
    const c = r.customers.find((x) => x.id === site.customerId);
    check('site-ledger-' + site.id, !!c && /^[a-f0-9-]{36}$/.test(site.id));
    const path = '/api/v1/admin/sites/' + site.id;
    const found = await api('site-read-' + site.id, 'GET', path, 200);
    check(
      'site-scope-' + site.id,
      found.data.id === site.id &&
        found.data.customerId === c.id &&
        [`${r.prefix}-site-${c.suffix}`, r.prefix + '-browser-updated'].includes(found.data.name),
    );
    await api('site-delete-' + site.id, 'DELETE', path, 200, { 'If-Match': String(found.data.version) });
    await api('site-absent-' + site.id, 'GET', path, 404);
    r.cleanup.push({ type: 'site', id: site.id, result: 'PASS' });
    save();
  }
  for (const own of [...child.createdIdentities, { username: parent.identity.username }]) {
    check(
      'identity-scope-' + own.username,
      own.username.startsWith(r.prefix + '-') && own.username.endsWith('@example.invalid'),
    );
    const found = await call(cognito, cognitoSdk.AdminGetUserCommand, {
      UserPoolId: pool,
      Username: own.username,
    }).catch((e) => {
      if (e.name === 'UserNotFoundException') return null;
      throw e;
    });
    if (found) {
      check(
        'identity-creation-' + own.username,
        found.UserAttributes?.find((a) => a.Name === 'email')?.Value === own.username &&
          found.UserCreateDate.getTime() >= Date.parse(parent.startedAt) - 5000,
      );
      await call(cognito, cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: own.username });
    }
    const absent = await call(cognito, cognitoSdk.AdminGetUserCommand, {
      UserPoolId: pool,
      Username: own.username,
    }).then(
      () => false,
      (e) => e.name === 'UserNotFoundException',
    );
    check('identity-absent-' + own.username, absent);
    r.cleanup.push({ type: 'identity', username: own.username, result: 'PASS' });
    save();
  }
  for (const c of r.customers) {
    const p = '/api/v1/admin/customers/' + c.id;
    const current = await api('customer-scope-' + c.suffix, 'GET', p, 200);
    check('customer-own-name-' + c.suffix, current.data.name === c.name);
    await api('customer-delete-' + c.suffix, 'DELETE', p, 200, { 'If-Match': String(current.data.version) });
    await api('customer-absent-' + c.suffix, 'GET', p, 404);
    r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
    save();
  }
  if (process.env.QA09_WAIT_FOR_FIXTURE_CLOSURE) {
    const path = process.env.QA09_WAIT_FOR_FIXTURE_CLOSURE;
    const until = Date.now() + 45 * 60000;
    let other;
    while (Date.now() < until) {
      try {
        other = JSON.parse(readFileSync(path));
      } catch {
        other = null;
      }
      if (other?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    check(
      'other-authorized-fixture-closed-before-original-audit',
      other?.finishedAt &&
        other.sourceCommit === r.sourceCommit &&
        other.prefix !== r.prefix &&
        other.parentGate === 'PASS' &&
        other.domainGate === 'PASS',
    );
    r.auditOrderingDependency = {
      path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      prefix: other.prefix,
      reason: 'AUDIT_ORIGINAL_BASELINE_AFTER_ALL_AUTHORIZED_DEVICE_FIXTURES_ARE_REMOVED',
    };
    save();
  }
  const audit = await db('audit-empty');
  check(
    'independent-empty-original-preserved',
    audit.empty === true && JSON.stringify(audit.originalFingerprints) === JSON.stringify(frame.originalFingerprints),
  );
  r.gate = 'PASS';
} catch (e) {
  r.gate = 'FAIL';
  r.failure = {
    name: e.name,
    code: e.Code ?? e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'RECOVERY_FAILED'),
    requestId: e.$metadata?.requestId,
    cliExitCode: e.cliExitCode,
    cliSignal: e.cliSignal,
    safeErrorClass: e.safeErrorClass,
    action: e.action,
    safeStderr: e.safeStderr,
  };
} finally {
  if (created)
    try {
      if (accessToken) await idp.globalSignOut(accessToken);
      await call(cognito, cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      const absent = await call(cognito, cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: username }).then(
        () => false,
        (e) => e.name === 'UserNotFoundException',
      );
      check('recovery-identity-absent', absent);
      r.cleanup.push({ type: 'recovery-identity', username, result: 'PASS' });
    } catch (e) {
      r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: 'FAIL', name: e.name });
    }
  r.finishedAt = new Date().toISOString();
  save();
}
if (r.gate === 'PASS') r.domain = await cleanupOwnedDomain(output, output + '.domain-cleanup.json');
save();
console.log(JSON.stringify({ gate: r.gate, failure: r.failure, cleanup: r.cleanup.length, domain: r.domain?.gate }));
process.exitCode = r.gate === 'PASS' && r.domain?.gate === 'PASS' ? 0 : 1;
