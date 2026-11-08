import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestDb } from '../apps/cloud-api/test/helpers.ts';
import {
  ROOT,
  CLOUD_PROFILE,
  CLOUD_INPUT_IDS,
  cloudInputTemplate,
  cloudReceiptTemplate,
  cloudAdmission,
  cloudCases,
  PACKAGE,
  CANDIDATE,
  INPUTS,
  sha,
  verifyG3,
  inputTemplate,
  admission,
  receiptTemplate,
  validateReceipt,
  validateCases,
  cases,
  manifestRows,
  artifactReader,
  assertRedacted,
  protocolDigest,
  expectedMigrations,
  ar12Scope,
  readCandidateFiles,
  readG3EvidenceFiles,
  isPreparationSource,
} from './device-image-target-package.mjs';

import {
  AR12_SOURCE_FILES,
  AR12_LOCAL_RECEIPT,
  AR12_LOCAL_REPORT,
  ar12ExclusionRecord,
  ar12VariantRecord,
} from './device-image-target-ar12-scope.mjs';
import { candidateFixture } from './test-support/device-image-candidate-fixture.mjs';

const clone = (value) => structuredClone(value);
test('preparation metadata cannot exempt application, infrastructure or shared handoff source', () => {
  for (const path of [
    'apps/cloud-api/src/runtime/admin-lambda.ts',
    'packages/auth/src/permissions.ts',
    'contracts/rest/openapi.bundle.json',
    'infra/iam/FDP-CloudFormationExecutionPolicy.json',
    'scripts/cloud-handoff-openapi.mjs',
    'package.json',
  ])
    assert.equal(isPreparationSource(path), false, path);
  assert.equal(isPreparationSource('scripts/device-image-target-package.mjs'), true);
  assert.equal(isPreparationSource(`${PACKAGE}/candidate.json`), true);
});
function structuralFixture() {
  // Deliberately synthetic metadata in memory only. A structural PASS is never G4 PASS.
  const files = new Map();
  const input = inputTemplate();
  for (const [id, , kind] of INPUTS) {
    if (kind === 'proof') continue;
    input.entries[id].value =
      kind === 'account'
        ? '111122223333'
        : kind === 'commit'
          ? CANDIDATE
          : kind === 'ref'
            ? `ref:fixture/${id}`
            : kind === 'origin'
              ? 'https://web.fixture.test'
              : kind === 'url'
                ? `https://${id.toLowerCase()}.fixture.test/api/v1`
                : `fixture-${id}`;
  }
  const env = Object.fromEntries(['accountId', 'region', 'stackName'].map((key) => [key, input.entries[key].value]));
  const versions = Object.fromEntries(
    ['adminApi', 'deviceApi', 'ingestion', 'mediaEvidence', 'outbox'].map((key) => [key, 'fixture-version']),
  );
  const details = {
    deploymentProof: { deployedSourceCommit: CANDIDATE, versions },
    migrationProof: {
      schemaSha256: sha(readFileSync(join(ROOT, 'packages/database/prisma/schema.prisma'))),
      appliedMigrations: expectedMigrations(),
      pendingMigrations: [],
    },
    runtimeVersionsProof: {
      versions,
      LIVE_IMAGE_CONTROL_TABLE: input.entries.controlTable.value,
      LIVE_IMAGE_PAYLOAD_TABLE: input.entries.payloadTable.value,
      allAuthorityWritersOnCandidate: true,
    },
    testScopeProof: {
      isolated: true,
      mayMutate: true,
      retirementAuthorized: true,
      disposableDeviceIds: [input.entries.otherDeviceId.value],
      deviceIds: [input.entries.deviceId.value, input.entries.otherDeviceId.value],
      customerIds: [input.entries.customerId.value, input.entries.otherCustomerId.value],
    },
    executionWindowProof: {
      startsAt: '2026-11-08T00:00:00Z',
      endsAt: '2026-11-10T00:00:00Z',
      permittedCloudCases: true,
    },
    nativeWindow: {
      databaseEngine: 'POSTGRESQL_NATIVE',
      storageEngine: 'AWS_DYNAMODB',
      independentProcesses: 2,
      independentPgConnections: 2,
    },
    faultPlan: {
      maxAffectedDevices: 2,
      restoreRequired: true,
      rollbackPlan: 'fixture rollback only',
      caseIds: cases()
        .filter((row) => row.area === 'native')
        .map((row) => row.id),
    },
    longWindow: { targetClockUnmodified: true, startsAt: '2026-11-08T00:00:00Z', endsAt: '2026-11-10T00:00:00Z' },
    scaleAndSla: {
      enabledDevices: 1,
      concurrentViewersPerDevice: 2,
      firstFrameTargetMs: 10000,
      networkProfile: 'fixture, not an approved SLA',
    },
    sequenceReservation: {
      deviceId: input.entries.deviceId.value,
      exclusive: true,
      originalCounterRecorded: true,
      firstSeq: 1,
      lastSeq: 100,
    },
    cleanupPlan: {
      usesResourceLedger: true,
      disableThroughAuthorityWriter: true,
      preserveControlEpoch: true,
      preserveHistoricalLinks: true,
      deleteOnlyOwnedKeys: true,
      retentionDecision: 'fixture only',
    },
  };
  for (const [id, , kind] of INPUTS)
    if (kind === 'proof') {
      const path = `proof-${id}.json`;
      const bytes = Buffer.from(
        JSON.stringify({
          mode: 'TARGET_CLOUD',
          syntheticResponsesAllowed: false,
          sourceCommit: CANDIDATE,
          ...env,
          inputId: id,
          passed: true,
          details: details[id],
        }),
      );
      files.set(path, bytes);
      input.entries[id].value = { path, sha256: sha(bytes) };
    }
  const receipt = receiptTemplate();
  Object.assign(receipt, {
    runId: 'IMG21-fixture-not-a-real-run',
    startedAt: '2026-11-08T00:00:00Z',
    finishedAt: '2026-11-09T01:00:00Z',
    execution: 'EXECUTED',
    environment: env,
  });
  function artifact(row, kind, variantId) {
    const id = `${row.id}-${variantId ?? kind}`;
    const path = `${id}.json`;
    const bytes = Buffer.from(
      JSON.stringify({
        mode: 'TARGET_CLOUD',
        syntheticResponsesAllowed: false,
        sourceCommit: CANDIDATE,
        runId: receipt.runId,
        ...env,
        caseId: row.id,
        kind,
        engine: kind === 'DB' ? 'POSTGRESQL_NATIVE' : kind === 'DDB' ? 'AWS_DYNAMODB' : undefined,
        variantId,
        capturedAt: '2026-11-08T01:00:00Z',
        data:
          kind === 'CLEANUP'
            ? {
                entries: [
                  {
                    id: 'fixture-viewer',
                    resourceType: 'VIEWER',
                    ownerRunId: receipt.runId,
                    deviceId: input.entries.deviceId.value,
                    disposition: 'RELEASED',
                  },
                ],
                postChecks: {
                  activeTestViewerCount: 0,
                  faultConfigurationRestored: true,
                  historicalLinksPreserved: true,
                },
              }
            : undefined,
      }),
    );
    files.set(path, bytes);
    receipt.artifacts.push({ id, path, sha256: sha(bytes) });
    return id;
  }
  for (const row of receipt.cases) {
    const plan = cases().find((p) => p.id === row.id);
    row.status = 'PASS';
    row.assertions = plan.assertions.map((a) => ({ id: a.id, passed: true }));
    row.evidenceRefs = plan.evidenceKinds.map((kind) => artifact(row, kind));
    row.variants = plan.requiredVariants.map((id) =>
      row.id === 'AR12' && id === 'no-media-permission'
        ? ar12VariantRecord(ar12Scope())
        : {
            id,
            status: 'PASS',
            evidenceRefs: [artifact(row, plan.evidenceKinds[0], id)],
          },
    );
  }
  receipt.cleanup = { status: 'PASS', ledgerRef: 'OP03-CLEANUP' };
  return {
    input,
    receipt,
    files,
    read: (path) => {
      assert.ok(files.has(path));
      return files.get(path);
    },
  };
}
test('G3 candidate binds historical hashes and rejects changed IAM source', async (t) => {
  const fixture = await candidateFixture();
  t.after(fixture.cleanup);
  const binding = fixture.tool.verifyG3();
  assert.equal(binding.sourceCommit, CANDIDATE);
  assert.equal(binding.sources.count, 1693);
  assert.equal(binding.artifacts.count, 13);
  assert.equal(binding.verificationSources.count, 1713);
  assert.equal(binding.g4, 'NOT_RUN');
  const path = 'infra/iam/FDP-CloudFormationExecutionPolicy.json';
  writeFileSync(join(fixture.root, path), readFileSync(join(fixture.root, path), 'utf8') + '\n');
  assert.throws(() => fixture.tool.verifyG3(), { message: `CURRENT_G3_SOURCE_DRIFT:${path}` });
  assert.throws(() => fixture.tool.buildPackage(), { message: `CURRENT_G3_SOURCE_DRIFT:${path}` });
  const run = spawnSync(process.execPath, [join(fixture.root, 'scripts/device-image-target-package.mjs'), '--check'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /CURRENT_G3_SOURCE_DRIFT:infra\/iam\/FDP-CloudFormationExecutionPolicy.json/u);
});
test('historical candidate package is deterministic, cwd-independent, complete and fresh', async (t) => {
  const fixture = await candidateFixture();
  t.after(fixture.cleanup);
  const a = fixture.tool.buildPackage(),
    b = fixture.tool.buildPackage();
  assert.deepEqual(a, b);
  assert.equal(Object.keys(a).length, 12);
  assert.equal(fixture.tool.writeOrCheck(true).status, 'PASS_OFFLINE_PACKAGE');
  const run = spawnSync(process.execPath, [join(fixture.root, 'scripts/device-image-target-package.mjs'), '--check'], {
    cwd: tmpdir(),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).cloudRequests, 0);
  // The real checkout still uses the strict production verifier. A passing
  // historical fixture cannot turn changed runtime/IAM source into a fresh gate.
  const manifest = JSON.parse(readFileSync(join(ROOT, PACKAGE, 'candidate.json')));
  const bytes = readG3EvidenceFiles([manifest.sources.path])[manifest.sources.path];
  const drift = manifestRows(bytes).find((row) => sha(readFileSync(join(ROOT, row.path))) !== row.sha256);
  if (drift) assert.throws(() => verifyG3(), { message: `CURRENT_G3_SOURCE_DRIFT:${drift.path}` });
  else assert.deepEqual(verifyG3(), fixture.tool.verifyG3());
});
test('case graph includes 44 cases and all five preview operations, full archive orders and authority variants', () => {
  const catalog = validateCases();
  assert.equal(catalog.length, 44);
  assert.equal(catalog.filter((c) => c.area === 'preview').length, 14);
  assert.equal(catalog.filter((c) => c.area === 'archive').length, 14);
  assert.equal(catalog.filter((c) => c.area === 'native').length, 12);
  assert.equal(catalog.filter((c) => c.area === 'operations').length, 4);
  assert.equal(catalog.find((c) => c.id === 'NC06').requiredVariants.length, 8);
  for (const id of ['AR01', 'AR02', 'AR03', 'AR04']) assert.ok(catalog.some((row) => row.id === id));
});
for (const [label, mutate] of [
  ['missing', (rows) => rows.pop()],
  ['duplicate', (rows) => (rows[1] = rows[0])],
  ['unknown operation', (rows) => rows[0].operations.push('getImaginaryReceipt')],
  ['future dependency', (rows) => rows[0].dependsOn.push('OP04')],
  ['preclaimed pass', (rows) => (rows[0].status = 'PASS')],
])
  test(`catalog rejects ${label}`, () => {
    const data = clone(cases());
    mutate(data);
    assert.throws(() => validateCases(data));
  });
test('template admission is BLOCKED with every missing input attributed; target receipt is NOT_RUN', () => {
  const input = inputTemplate();
  const result = admission(input);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.blocked.length, 35);
  assert.ok(result.blocked.every((row) => row.ownerRole));
  const receipt = validateReceipt(receiptTemplate(), input, () => assert.fail('template must not read evidence'));
  assert.equal(receipt.status, 'NOT_RUN');
  assert.equal(receipt.g4, 'NOT_RUN');
  assert.equal(receipt.pending.length, 44);
});
test('complete structural metadata with valid source exclusion does not grant G4', () => {
  const f = structuralFixture();
  assert.equal(admission(f.input, f.read).status, 'PASS_INPUT_STRUCTURE_ONLY');
  const result = validateReceipt(f.receipt, f.input, f.read);
  assert.equal(result.status, 'PASS_STRUCTURE_ONLY');
  assert.deepEqual(result.blocked, []);
  assert.equal(result.g4, 'NOT_RUN');
  assert.equal(result.requiresRealExecutionReview, true);
  assert.equal(result.cloudRequests, 0);
});
for (const [label, mutate] of [
  ['wrong candidate', (f) => (f.receipt.sourceCommit = 'a'.repeat(40))],
  ['old protocol', (f) => (f.receipt.protocolDigest = 'a'.repeat(64))],
  ['mock mode', (f) => (f.receipt.mode = 'LOCAL_FIXTURE')],
  ['synthetic permitted', (f) => (f.receipt.syntheticResponsesAllowed = true)],
  ['G4 promotion', (f) => (f.receipt.g4 = 'PASS')],
  ['missing case', (f) => f.receipt.cases.pop()],
  ['duplicate case', (f) => (f.receipt.cases[1] = f.receipt.cases[0])],
  ['failed case', (f) => (f.receipt.cases[0].status = 'FAIL')],
  ['missing assertion', (f) => f.receipt.cases[0].assertions.pop()],
  ['missing evidence kind', (f) => f.receipt.cases[0].evidenceRefs.pop()],
  ['wrong artifact hash', (f) => (f.receipt.artifacts[0].sha256 = 'a'.repeat(64))],
  ['missing variant', (f) => f.receipt.cases.find((row) => row.id === 'NC06').variants.pop()],
  ['unproven variant', (f) => (f.receipt.cases.find((row) => row.id === 'NC06').variants[0].evidenceRefs = [])],
  ['cleanup missing', (f) => (f.receipt.cleanup.status = 'NOT_RUN')],
  ['cross-run cleanup', (f) => (f.receipt.cleanup.ledgerRef = 'PV02-HTTP')],
  ['wrong environment', (f) => (f.receipt.environment.stackName = 'foreign')],
  ['unexecuted claim', (f) => (f.receipt.execution = 'NOT_RUN')],
  ['unsafe proof path', (f) => (f.input.entries.deploymentProof.value.path = '../private.json')],
  ['wrong deployment', (f) => (f.input.entries.deployedCommit.value = 'b'.repeat(40))],
  ['same viewers', (f) => (f.input.entries.viewerARef.value = f.input.entries.viewerBRef.value)],
  ['invalid endpoint', (f) => (f.input.entries.adminBaseUrl.value = 'http://target.example.invalid')],
])
  test(`receipt/admission fails closed: ${label}`, () => {
    const f = structuralFixture();
    mutate(f);
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
  });
test('BLOCKED and NOT_RUN evidence cannot be promoted even if other rows pass', () => {
  for (const status of ['BLOCKED', 'NOT_RUN']) {
    const f = structuralFixture();
    f.receipt.cases[0].status = status;
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, status);
  }
});
for (const [label, change] of [
  ['mock evidence', (e) => (e.mode = 'LOCAL_FIXTURE')],
  ['different tenant environment', (e) => (e.accountId = '999988887777')],
  ['different candidate', (e) => (e.sourceCommit = 'a'.repeat(40))],
  ['outside window', (e) => (e.capturedAt = '2026-11-01T00:00:00Z')],
  ['signed URL', (e) => (e.uploadUrl = 'https://private.fixture.test/?X-Amz-Signature=not-real')],
  ['Base64', (e) => (e.imageBase64 = 'do-not-log-image')],
])
  test(`rehashing cannot legitimize ${label}`, () => {
    const f = structuralFixture();
    const row = f.receipt.artifacts[0];
    const evidence = JSON.parse(f.files.get(row.path));
    change(evidence);
    const bytes = Buffer.from(JSON.stringify(evidence));
    f.files.set(row.path, bytes);
    row.sha256 = sha(bytes);
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
  });
test('artifact reader refuses traversal and symlink escapes without reading secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'img21-paths-'));
  const inner = join(directory, 'inner');
  writeFileSync(inner, 'test');
  const sub = mkdtempSync(join(directory, 'run-'));
  symlinkSync(inner, join(sub, 'outside.json'));
  try {
    const reader = artifactReader(sub);
    assert.throws(() => reader('../inner'));
    assert.throws(() => reader('outside.json'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('manifest parser rejects malformed, duplicate, absolute and parent paths', () => {
  for (const path of ['/private/file', '../file', 'folder/../file', 'folder//file'])
    assert.throws(() => manifestRows(Buffer.from('a'.repeat(64) + '  ' + path + '\n')));
  assert.throws(() => manifestRows(Buffer.from('a'.repeat(64) + '  one\n' + 'a'.repeat(64) + '  one\n')));
  assert.throws(() => manifestRows(Buffer.from('missing hash')));
});
test('redaction checker rejects sensitive values while allowing opaque row identifiers and hashes', () => {
  for (const value of [
    { imageBase64: 'raw' },
    { authorization: 'Bearer fixture-not-real' },
    { privateKey: 'not-a-key' },
    { secretAccessKey: 'not-real' },
    { accessKeyId: 'not-real' },
    { url: 'https://test/?X-Amz-Signature=not-real' },
  ])
    assert.throws(() => assertRedacted(value));
  assert.doesNotThrow(() =>
    assertRedacted({
      sessionId: 'opaque',
      sourceMessageId: 'IMG21-fixture',
      sha256: 'a'.repeat(64),
      uploadUrl: '[REDACTED]',
    }),
  );
});
test('CLI has no cloud execution mode and all template target checks exit nonzero', () => {
  const script = join(ROOT, 'scripts/device-image-target-package.mjs');
  for (const arg of ['--execute', '--deploy', '--migrate'])
    assert.equal(spawnSync(process.execPath, [script, arg], { encoding: 'utf8' }).status, 1);
  const run = spawnSync(process.execPath, [script, '--admission', join(ROOT, PACKAGE, 'inputs.template.json')], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).status, 'BLOCKED');
  const body = readFileSync(script, 'utf8');
  assert.doesNotMatch(body, /from ['"](?:@aws-sdk|node:(?:https?|net|tls))|\bfetch\(/u);
  assert.equal(protocolDigest().length, 64);
});
test('read-only probes execute against all local migrations; native PID diagnostic remains target-only', async () => {
  const db = await createTestDb();
  try {
    let sql =
      readFileSync(join(ROOT, 'scripts/device-image-target-read-only.sql'), 'utf8').split('-- PID pairs')[0] +
      'ROLLBACK;';
    sql = sql.replace(/:'([a-z_]+)'/gu, (_, key) => (key === 'media_seq' ? "'1'" : "'fixture-id'"));
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/iu);
    await db.pg.exec(sql);
  } finally {
    await db.prisma.$disconnect();
    await db.pg.close();
  }
});

for (const [id] of INPUTS.filter((row) => row[2] === 'proof'))
  test(`rehashing cannot replace detailed ${id} with a PASS flag`, () => {
    const f = structuralFixture();
    const row = f.input.entries[id].value;
    const value = JSON.parse(f.files.get(row.path));
    delete value.details;
    const bytes = Buffer.from(JSON.stringify(value));
    f.files.set(row.path, bytes);
    row.sha256 = sha(bytes);
    assert.equal(admission(f.input, f.read).status, 'FAIL');
  });
test('native storage evidence cannot be replaced by PGlite or a DDB command mock', () => {
  for (const [kind, engine] of [
    ['DB', 'PGLITE'],
    ['DDB', 'SDK_MOCK'],
  ]) {
    const f = structuralFixture();
    const row = f.receipt.artifacts.find((row) => row.id.endsWith('-' + kind));
    const value = JSON.parse(f.files.get(row.path));
    value.engine = engine;
    const bytes = Buffer.from(JSON.stringify(value));
    f.files.set(row.path, bytes);
    row.sha256 = sha(bytes);
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
  }
});
test('short or unauthorized execution windows cannot claim the real 24 hour terminal case', () => {
  for (const end of ['2026-11-08T01:00:00Z', '2026-11-11T01:00:00Z']) {
    const f = structuralFixture();
    f.receipt.finishedAt = end;
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
  }
});

test('rehashing an empty, foreign or epoch-deleting cleanup ledger is rejected', () => {
  for (const mutate of [
    (data) => (data.entries = []),
    (data) => (data.entries[0].ownerRunId = 'foreign'),
    (data) => Object.assign(data.entries[0], { resourceType: 'DDB_CONTROL', disposition: 'REMOVED' }),
  ]) {
    const f = structuralFixture();
    const row = f.receipt.artifacts.find((row) => row.id === 'OP03-CLEANUP');
    const evidence = JSON.parse(f.files.get(row.path));
    mutate(evidence.data);
    const bytes = Buffer.from(JSON.stringify(evidence));
    f.files.set(row.path, bytes);
    row.sha256 = sha(bytes);
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
  }
});

test('raw credentials hidden in additional input fields are rejected without echoing values', () => {
  const f = structuralFixture();
  f.input.password = 'not-a-real-password';
  const result = admission(f.input, f.read);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.includes('SENSITIVE_INPUT'));
  assert.equal(JSON.stringify(result).includes('not-a-real-password'), false);
});

test('AR12 retains six records: five target variants and exactly one source-bound N/A', () => {
  const scope = ar12Scope(),
    r = receiptTemplate(),
    row = r.cases.find((row) => row.id === 'AR12');
  assert.equal(row.status, 'NOT_RUN');
  assert.equal(row.variants.length, 6);
  assert.equal(row.variants.filter((v) => v.status === 'NOT_RUN').length, 5);
  assert.deepEqual(
    row.variants.find((v) => v.id === 'no-media-permission'),
    ar12VariantRecord(scope),
  );
  assert.deepEqual(r.sourceExclusions, [ar12ExclusionRecord(scope)]);
  assert.equal(scope.localRegression.passedTests, 34);
  assert.equal(scope.targetExecutionProven, false);
  assert.ok(INPUTS.some((row) => row[0] === 'rejectedIdentityRef'));
  assert.ok(!INPUTS.some((row) => row[0] === 'noMediaRoleRef'));
});
for (const [name, mutate] of [
  ['missing exclusion', (f) => delete f.receipt.sourceExclusions],
  ['duplicate exclusion', (f) => f.receipt.sourceExclusions.push(clone(f.receipt.sourceExclusions[0]))],
  ['wrong decision', (f) => (f.receipt.sourceExclusions[0].decisionId = 'waive-all')],
  ['wrong candidate', (f) => (f.receipt.sourceExclusions[0].sourceCommit = 'a'.repeat(40))],
  ['old policy digest', (f) => (f.receipt.sourceExclusions[0].policyDigest = 'a'.repeat(64))],
  ['target evidence claim', (f) => (f.receipt.sourceExclusions[0].targetExecuted = true)],
  ['attached target evidence', (f) => (f.receipt.sourceExclusions[0].evidenceRefs = ['AR12-HTTP'])],
  ['N/A disguised as PASS', (f) => (f.receipt.sourceExclusions[0].status = 'PASS')],
  ['whole AR12 skipped', (f) => (f.receipt.cases.find((r) => r.id === 'AR12').status = 'NOT_APPLICABLE')],
  [
    'branch claimed target PASS',
    (f) =>
      (f.receipt.cases.find((r) => r.id === 'AR12').variants.find((v) => v.id === 'no-media-permission').status =
        'PASS'),
  ],
  [
    'branch deleted',
    (f) =>
      (f.receipt.cases.find((r) => r.id === 'AR12').variants = f.receipt.cases
        .find((r) => r.id === 'AR12')
        .variants.filter((v) => v.id !== 'no-media-permission')),
  ],
  [
    'other AR12 branch skipped',
    (f) =>
      (f.receipt.cases.find((r) => r.id === 'AR12').variants.find((v) => v.id === 'deleted').status = 'NOT_APPLICABLE'),
  ],
  ['another case skipped', (f) => (f.receipt.cases.find((r) => r.id === 'NC06').variants[0].status = 'NOT_APPLICABLE')],
  ['missing AR12 target evidence', (f) => (f.receipt.cases.find((r) => r.id === 'AR12').evidenceRefs = [])],
  ['target AR12 failure', (f) => (f.receipt.cases.find((r) => r.id === 'AR12').status = 'FAIL')],
])
  test(`source-bound N/A cannot waive: ${name}`, () => {
    const f = structuralFixture();
    mutate(f);
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
  });
test('forged N/A is rejected even while the parent case is NOT_RUN', () => {
  const r = receiptTemplate();
  r.cases.find((row) => row.id === 'NC06').variants[0].status = 'NOT_APPLICABLE';
  assert.equal(validateReceipt(r, inputTemplate(), () => assert.fail()).status, 'FAIL');
});
test('AR12 target BLOCKED/NOT_RUN still prevents completion', () => {
  for (const status of ['BLOCKED', 'NOT_RUN']) {
    const f = structuralFixture();
    f.receipt.cases.find((r) => r.id === 'AR12').status = status;
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, status);
  }
});
test('permuted JSON object keys do not change the exact N/A decision', () => {
  const f = structuralFixture();
  f.receipt.sourceExclusions[0] = Object.fromEntries(Object.entries(f.receipt.sourceExclusions[0]).reverse());
  assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'PASS_STRUCTURE_ONLY');
});
for (const path of AR12_SOURCE_FILES)
  test(`source scope is invalidated by ${path} drift without editing runtime files`, () => {
    const reader = (p) => {
      const bytes = readFileSync(join(ROOT, p));
      return p === path ? Buffer.concat([bytes, Buffer.from('\nchanged-fixture-only')]) : bytes;
    };
    assert.throws(() => ar12Scope(reader, readCandidateFiles), /AR12_SOURCE_SCOPE_DRIFT/);
  });
for (const name of [
  'missing local receipt',
  'failed local report',
  'missing denial case',
  'missing matrix role',
  'rehash wrong source',
])
  test(`source exemption rejects ${name}`, () => {
    const record = JSON.parse(readFileSync(join(ROOT, AR12_LOCAL_RECEIPT)));
    const report = JSON.parse(readFileSync(join(ROOT, AR12_LOCAL_REPORT)));
    if (name === 'failed local report') report.success = false;
    if (name === 'missing denial case') report.testResults[0].assertionResults[0].title = 'not-the-required-test';
    if (name === 'missing matrix role')
      report.testResults[0].assertionResults.find(
        (r) => r.title === 'Auditor follows the current permission matrix',
      ).title = 'unknown role';
    if (name === 'rehash wrong source') record.sourceHashes[AR12_SOURCE_FILES[0]] = 'a'.repeat(64);
    if (name === 'missing denial case')
      report.testResults[0].assertionResults.find(
        (r) => r.title === 'ALARM missing media:read omits the field and never queries images',
      ).title = 'unknown branch';
    const reportBytes = Buffer.from(JSON.stringify(report));
    record.report.sha256 = sha(reportBytes);
    const reader = (p) => {
      if (p === AR12_LOCAL_RECEIPT) {
        if (name === 'missing local receipt') throw new Error('fixture missing');
        return Buffer.from(JSON.stringify(record));
      }
      if (p === AR12_LOCAL_REPORT) return reportBytes;
      return readFileSync(join(ROOT, p));
    };
    assert.throws(() => ar12Scope(reader, readCandidateFiles), /AR12_/);
  });
test('source/local regression loss restores BLOCKED rather than silently exempting the branch', () => {
  const f = structuralFixture(),
    scopeProvider = () => {
      throw new Error('AR12_SCOPE_INVALID_FIXTURE');
    };
  const a = admission(f.input, f.read, scopeProvider);
  assert.equal(a.status, 'BLOCKED');
  assert.equal(a.blocked[0].id, 'ar12ScopeRevalidationRequired');
  const r = validateReceipt(f.receipt, f.input, f.read, scopeProvider);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.g4, 'NOT_RUN');
});
test('old receipt shapes cannot become current by only replacing protocolDigest', () => {
  const r = receiptTemplate();
  delete r.sourceExclusions;
  r.cases.find((row) => row.id === 'AR12').variants.find((v) => v.id === 'no-media-permission').status = 'NOT_RUN';
  assert.equal(validateReceipt(r, inputTemplate(), () => assert.fail()).status, 'FAIL');
});

test('active variant failure or blocker is retained under a NOT_RUN parent, even with valid source N/A', () => {
  for (const status of ['FAIL', 'BLOCKED']) {
    const r = receiptTemplate();
    r.cases.find((row) => row.id === 'AR12').variants.find((v) => v.id === 'deleted').status = status;
    assert.equal(validateReceipt(r, inputTemplate(), () => assert.fail()).status, status);
  }
});

test('retired impossible-role input name is rejected rather than silently reused', () => {
  const f = structuralFixture();
  f.input.entries.noMediaRoleRef = f.input.entries.rejectedIdentityRef;
  delete f.input.entries.rejectedIdentityRef;
  assert.equal(admission(f.input, f.read).status, 'FAIL');
});

for (const [name, change] of [
  ['delete source branch', (r) => (r.requiredVariants = r.requiredVariants.filter((v) => v !== 'no-media-permission'))],
  ['delete active branch', (r) => (r.requiredVariants = r.requiredVariants.filter((v) => v !== 'deleted'))],
  ['drop target evidence kind', (r) => r.evidenceKinds.pop()],
  ['drop target assertion', (r) => r.assertions.pop()],
])
  test(`AR12 catalog cannot reduce target scope: ${name}`, () => {
    const data = clone(cases());
    change(data.find((r) => r.id === 'AR12'));
    assert.throws(() => validateCases(data), /AR12_TARGET_SCOPE_REDUCED/);
  });
test('unreferenced target artifacts cannot claim execution of the source-only N/A branch', () => {
  const f = structuralFixture();
  const original = f.receipt.artifacts.find((row) => row.id === 'AR12-HTTP');
  const value = JSON.parse(f.files.get(original.path));
  value.variantId = 'no-media-permission';
  const bytes = Buffer.from(JSON.stringify(value));
  f.files.set('forged-na.json', bytes);
  f.receipt.artifacts.push({ id: 'forged-na', path: 'forged-na.json', sha256: sha(bytes) });
  assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
});

test('a filtered seven-case report cannot masquerade as the complete 34-case local regression', () => {
  const record = JSON.parse(readFileSync(join(ROOT, AR12_LOCAL_RECEIPT))),
    report = JSON.parse(readFileSync(join(ROOT, AR12_LOCAL_REPORT)));
  report.testResults[0].assertionResults = report.testResults[0].assertionResults.filter(
    (row) =>
      row.title.includes('missing media:read omits') || row.title.includes('follows the current permission matrix'),
  );
  report.numPassedTests = 7;
  report.numTotalTests = 7;
  const bytes = Buffer.from(JSON.stringify(report));
  record.report.sha256 = sha(bytes);
  const read = (p) =>
    p === AR12_LOCAL_REPORT
      ? bytes
      : p === AR12_LOCAL_RECEIPT
        ? Buffer.from(JSON.stringify(record))
        : readFileSync(join(ROOT, p));
  assert.throws(() => ar12Scope(read, readCandidateFiles), /AR12_LOCAL_REGRESSION_NOT_PASSED/);
});

// Synthetic metadata stays in memory: even a fully valid fixture cannot produce G4 PASS.
function cloudFixture() {
  const original = structuralFixture();
  const input = cloudInputTemplate();
  input.runId = 'IMG21-CLOUD-fixture-0001';
  for (const id of CLOUD_INPUT_IDS) input.entries[id] = clone(original.input.entries[id]);
  const files = new Map();
  const put = (path, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    files.set(path, bytes);
    return { path, sha256: sha(bytes) };
  };
  for (const id of CLOUD_INPUT_IDS.filter((id) => input.entries[id].kind === 'proof')) {
    const proof = JSON.parse(original.files.get(input.entries[id].value.path));
    Object.assign(proof, {
      profile: CLOUD_PROFILE,
      protocolDigest: protocolDigest(),
      runId: input.runId,
      capturedAt: '2026-11-08T00:01:00Z',
    });
    if (id === 'testScopeProof')
      proof.details = {
        isolated: true,
        mayMutate: true,
        client: 'CONTROLLED_SIMULATOR',
        deviceIds: [input.entries.deviceId.value],
        customerIds: [input.entries.customerId.value],
        caseIds: ['CF01', 'CF02', 'CF03'],
      };
    if (id === 'executionWindowProof')
      proof.details = {
        startsAt: '2026-11-08T00:00:00Z',
        endsAt: '2026-11-08T01:00:00Z',
        permittedCloudCases: true,
        caseIds: ['CF01', 'CF02', 'CF03'],
      };
    input.entries[id].value = put(`proofs/${id}.json`, proof);
  }
  const receipt = cloudReceiptTemplate();
  Object.assign(receipt, {
    runId: input.runId,
    startedAt: '2026-11-08T00:01:00Z',
    finishedAt: '2026-11-08T00:30:00Z',
    environment: {
      accountId: input.entries.accountId.value,
      region: input.entries.region.value,
      stackName: input.entries.stackName.value,
    },
    execution: 'EXECUTED',
  });
  const digest = 'a'.repeat(64);
  const add = (caseId, kind, data) => {
    const id = `${caseId}-${kind}`;
    receipt.artifacts.push({
      id,
      ...put(`${id}.json`, {
        mode: 'TARGET_CLOUD',
        profile: CLOUD_PROFILE,
        protocolDigest: protocolDigest(),
        sourceCommit: CANDIDATE,
        syntheticResponsesAllowed: false,
        runId: receipt.runId,
        ...receipt.environment,
        caseId,
        kind,
        capturedAt: '2026-11-08T00:10:00Z',
        data,
      }),
    });
    return id;
  };
  for (const row of receipt.cases) {
    const plan = cloudCases().find((r) => r.id === row.id);
    const http = {
      deviceId: input.entries.deviceId.value,
      customerId: input.entries.customerId.value,
      requestId: 'fixture-request',
    };
    const client = { sentSha256: digest, receivedSha256: digest, sizeBytes: 811, jpegDecoded: true };
    if (row.id === 'CF01') {
      Object.assign(http, {
        leaseStatus: 200,
        stateStatus: 200,
        state: 'ACTIVE',
        uploadStatus: 200,
        latestStatus: 200,
        latestState: 'READY',
        streamId: 'fixture-stream',
        frameId: 'fixture-frame',
        releaseStatus: 204,
      });
      Object.assign(client, { streamId: http.streamId, frameId: http.frameId });
    } else {
      const kind = row.id === 'CF02' ? 'EVENT' : 'ALARM';
      Object.assign(http, {
        triggerKind: kind,
        sourceMessageId: `${row.id}-source`,
        mediaId: `${row.id}-media`,
        objectPath: `${row.id}/image.jpg`,
        sessionStatus: 201,
        registrationStatus: 409,
        registrationCode: 'MEDIA_ALREADY_REGISTERED',
        registeredMediaId: `${row.id}-media`,
        evidenceMediaId: `${row.id}-media`,
        queryStatus: 200,
        evidenceStatus: 'AVAILABLE',
        downloadStatus: 200,
        evidenceSourceMessageId: `${row.id}-source`,
      });
      Object.assign(client, { mediaId: http.mediaId });
      add(row.id, 'S3', {
        putStatus: 200,
        requestId: 'fixture-s3-request',
        objectPath: http.objectPath,
        sha256: digest,
        sizeBytes: 811,
      });
      add(row.id, 'MQTT', {
        triggerKind: kind,
        sourceMessageId: http.sourceMessageId,
        triggerRefMessageId: http.sourceMessageId,
        mediaObjectPath: http.objectPath,
        mediaMessageId: `${row.id}-media-message`,
        ...(kind === 'ALARM' ? { alarmStatus: 'ACTIVE' } : {}),
      });
    }
    add(row.id, 'HTTP', http);
    add(row.id, 'CLIENT', client);
    row.status = 'PASS';
    row.assertions = plan.assertions.map(({ id }) => ({ id, passed: true }));
    row.evidenceRefs = receipt.artifacts.filter((r) => r.id.startsWith(row.id)).map((r) => r.id);
  }
  receipt.cleanup = {
    status: 'PASS',
    ledgerRef: add('OP03', 'CLEANUP', {
      entries: [
        {
          id: 'fixture-viewer',
          resourceType: 'VIEWER',
          ownerRunId: receipt.runId,
          deviceId: input.entries.deviceId.value,
          disposition: 'RELEASED',
        },
      ],
      postChecks: { activeTestViewerCount: 0, faultConfigurationRestored: true, historicalLinksPreserved: true },
    }),
  };
  return {
    input,
    receipt,
    files,
    read: (path) => {
      assert.ok(files.has(path), path);
      return files.get(path);
    },
    proof: (id, mutate) => {
      const p = input.entries[id].value.path;
      const v = JSON.parse(files.get(p));
      mutate(v);
      input.entries[id].value = put(p, v);
    },
    artifact: (id, mutate) => {
      const a = receipt.artifacts.find((r) => r.id === id);
      const v = JSON.parse(files.get(a.path));
      mutate(v);
      a.sha256 = put(a.path, v).sha256;
    },
  };
}
test('cloud Gate requires only preview and EVENT/ALARM interfaces, no App or extended/native/SLA inputs', () => {
  const f = cloudFixture();
  assert.equal(CLOUD_INPUT_IDS.length, 22);
  for (const id of [
    'nativeWindow',
    'faultPlan',
    'longWindow',
    'scaleAndSla',
    'otherDeviceId',
    'otherDeviceMtlsRef',
    'viewerBRef',
  ])
    assert.equal(f.input.entries[id], undefined, id);
  assert.equal(cloudAdmission(f.input, f.read, Date.parse('2026-11-08T00:20:00Z')).status, 'PASS_INPUT_STRUCTURE_ONLY');
  const r = validateReceipt(f.receipt, f.input, f.read);
  assert.equal(r.status, 'PASS_STRUCTURE_ONLY');
  assert.equal(r.g4, 'NOT_RUN');
  assert.equal(r.thirdPartyAppRequired, false);
  assert.equal(r.extendedSuiteRequired, false);
  assert.equal(r.requiresRealExecutionReview, true);
});
test('cloud templates remain NOT_RUN and missing target inputs remain BLOCKED', () => {
  const i = cloudInputTemplate(),
    r = cloudReceiptTemplate();
  assert.equal(cloudAdmission(i, () => assert.fail()).status, 'BLOCKED');
  assert.equal(validateReceipt(r, i, () => assert.fail()).status, 'NOT_RUN');
});
test('cloud execution window can be scheduled but an expired window cannot admit a new run', () => {
  const f = cloudFixture();
  const scheduled = cloudAdmission(f.input, f.read, Date.parse('2026-11-07T23:00:00Z'));
  assert.equal(scheduled.status, 'PASS_INPUT_STRUCTURE_ONLY');
  assert.equal(scheduled.windowState, 'SCHEDULED');
  assert.equal(scheduled.executionReady, false);
  assert.equal(cloudAdmission(f.input, f.read, Date.parse('2026-11-08T02:00:00Z')).status, 'BLOCKED');
});
for (const [name, mutate] of [
  ['wrong image hash', (f) => f.artifact('CF01-CLIENT', (a) => (a.data.receivedSha256 = 'b'.repeat(64)))],
  ['not decoded JPEG', (f) => f.artifact('CF01-CLIENT', (a) => (a.data.jpegDecoded = false))],
  ['wrong stream', (f) => f.artifact('CF01-CLIENT', (a) => (a.data.streamId = 'old-stream'))],
  ['WAITING_FRAME', (f) => f.artifact('CF01-HTTP', (a) => (a.data.latestState = 'WAITING_FRAME'))],
  ['foreign tenant', (f) => f.artifact('CF02-HTTP', (a) => (a.data.customerId = 'another-customer'))],
  ['wrong triggerRef', (f) => f.artifact('CF02-MQTT', (a) => (a.data.triggerRefMessageId = 'wrong-message'))],
  ['PUBACK without registration', (f) => f.artifact('CF02-HTTP', (a) => (a.data.registrationStatus = 200))],
  ['unassociated image', (f) => f.artifact('CF02-HTTP', (a) => (a.data.evidenceStatus = null))],
  ['ALARM clear instead of active', (f) => f.artifact('CF03-MQTT', (a) => (a.data.alarmStatus = 'CLEARED'))],
  ['S3 object mismatch', (f) => f.artifact('CF03-S3', (a) => (a.data.objectPath = 'other-object'))],
  ['S3 truncated bytes', (f) => f.artifact('CF02-S3', (a) => (a.data.sizeBytes = 1))],
  ['download failed', (f) => f.artifact('CF03-HTTP', (a) => (a.data.downloadStatus = 403))],
  ['wrong associated media', (f) => f.artifact('CF02-HTTP', (a) => (a.data.evidenceMediaId = 'other-media'))],
  ['wrong registration media', (f) => f.artifact('CF03-HTTP', (a) => (a.data.registeredMediaId = 'other-media'))],
  ['missing EVENT case', (f) => f.receipt.cases.splice(1, 1)],
  ['raw target claim', (f) => (f.receipt.g4 = 'PASS')],
  ['receipt profile replay', (f) => delete f.receipt.profile],
  ['proof old candidate', (f) => f.proof('deploymentProof', (p) => (p.sourceCommit = '6'.repeat(40)))],
  ['proof old protocol', (f) => f.proof('deploymentProof', (p) => (p.protocolDigest = '0'.repeat(64)))],
  ['unapproved proof draft', (f) => f.proof('executionWindowProof', (p) => (p.passed = false))],
  ['wrong run', (f) => (f.input.runId = 'IMG21-CLOUD-other-run')],
  ['outside window', (f) => (f.receipt.finishedAt = '2026-11-08T02:00:00Z')],
  ['old version observation', (f) => f.proof('runtimeVersionsProof', (p) => (p.capturedAt = '2026-11-07T23:59:00Z'))],
  [
    'mixed deployed versions',
    (f) => f.proof('runtimeVersionsProof', (p) => (p.details.versions.adminApi = 'different-version')),
  ],
  ['local mocked evidence', (f) => f.artifact('CF01-HTTP', (a) => (a.mode = 'LOCAL_FIXTURE'))],
  ['artifact wrong protocol', (f) => f.artifact('CF01-HTTP', (a) => (a.protocolDigest = '0'.repeat(64)))],
  ['invalid receipt time', (f) => (f.receipt.startedAt = 'not-a-date')],
  ['missing cleanup', (f) => (f.receipt.cleanup.status = 'NOT_RUN')],
])
  test(`cloud interface Gate rejects ${name}`, () => {
    const f = cloudFixture();
    mutate(f);
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, 'FAIL');
  });
test('core FAIL and BLOCKED are retained, while lack of App artifacts has no effect', () => {
  for (const status of ['FAIL', 'BLOCKED', 'NOT_RUN']) {
    const f = cloudFixture();
    f.receipt.cases[1].status = status;
    assert.equal(validateReceipt(f.receipt, f.input, f.read).status, status);
  }
});
test('cloud scope cannot request retirement, another device or expanded cases', () => {
  const f = cloudFixture();
  f.proof('testScopeProof', (p) => p.details.deviceIds.push('foreign-device'));
  assert.equal(cloudAdmission(f.input, f.read, Date.parse('2026-11-08T00:20:00Z')).status, 'FAIL');
});
