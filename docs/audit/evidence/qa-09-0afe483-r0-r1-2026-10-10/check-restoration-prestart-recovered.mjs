// Local, read-only verification of original bridge receipts; never alters a receipt or calls AWS.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { transientFixtureRead } from '../../../../scripts/qa09-operation-observation.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
assert.equal(mode, 'restore');
const dir = join(root, mode), output = join(dir, 'prestart-entry-gate.json');
assert.ok(!existsSync(output), 'FRESH_GATE_REQUIRED');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const bindings = {}, names = new Set(['capacity-before.json']);
if (mode === 'r0' || mode === 'r1') {
  for (const name of ['sample.json', 'sample.json.fixtures.json']) {
    const bytes = readFileSync(join(dir, name)), ledger = JSON.parse(bytes);
    assert.equal(ledger.gate, 'PASS'); bindings[name] = hash(bytes);
    for (const row of ledger.databaseBuilds) {
      assert.equal(row.gate, 'PASS');
      assert.equal(dirname(resolve(row.receipt)), resolve(dir), 'OWN_UNIT_RECEIPT_REQUIRED');
      names.add(basename(row.receipt));
    }
  }
  names.add('database-empty-audit.json');
} else if (mode === 'restore') names.add('database-empty-audit.json');
const observations = [];
for (const name of names) {
  const bytes = readFileSync(join(dir, name)), v = JSON.parse(bytes);
  const originalFailed = name === 'database-empty-audit.json';
  let effective = v;
  if (originalFailed) {
    assert.equal(v.gate, 'FAIL');
    assert.equal(v.failure.code, 'AWS_batch-get-builds_CLI_READ_TIMEOUT');
    assert.equal(v.failure.kind, 'STARTED_BUILD_READ_OR_VERIFICATION');
    assert.equal(v.failure.recoveryAction, 'EXACT_EXISTING_BUILD_READ_ONLY');
    const recoveredBytes = readFileSync(join(dir, 'database-empty-audit.recovered.json'));
    effective = JSON.parse(recoveredBytes);
    assert.equal(effective.gate, 'PASS'); assert.equal(effective.originalGate, 'FAIL');
    assert.equal(effective.scope, 'EXACT_STARTED_BUILD_READ_ONLY_RESULT_RECOVERY'); assert.equal(effective.writes, 0);
    assert.equal(effective.recoveredFromSha256, hash(bytes));
    assert.equal(effective.preparationSha256, hash(readFileSync(join(dir, name + '.preparation.json'))));
    assert.equal(effective.build.id, v.build.id);
    bindings['database-empty-audit.recovered.json'] = hash(recoveredBytes);
    const closureBytes = readFileSync(join(dir, 'post-restoration-readonly.json')), closure = JSON.parse(closureBytes);
    assert.equal(closure.gate, 'PASS'); assert.equal(closure.originalAuditClientGate, 'FAIL');
    assert.equal(closure.effectiveAuditGate, 'PASS'); assert.equal(closure.newAuditBuildOnRecovery, false);
    for (const [n,h] of Object.entries(closure.bindings)) assert.equal(hash(readFileSync(join(dir,n))),h);
    bindings['post-restoration-readonly.json'] = hash(closureBytes);
  } else assert.equal(v.gate, 'PASS');
  assert.equal(effective.build.status, 'SUCCEEDED');
  const prepName = name + '.preparation.json', prepBytes = readFileSync(join(dir, prepName)), prep = JSON.parse(prepBytes);
  const startedName = name + '.started.json', startedBytes = readFileSync(join(dir, startedName)), started = JSON.parse(startedBytes);
  assert.equal(started.preparationSha256, hash(prepBytes)); assert.equal(started.build.id, v.build.id);
  assert.equal(prep.sourceHash, v.sourceHash); assert.equal(prep.buildspecHash, v.buildspecHash);
  assert.equal(hash(prep.project.source.buildspec), v.buildspecHash);
  assert.equal(effective.result.prefix, prep.plan.prefix); assert.equal(effective.result.action, prep.plan.action); assert.equal(effective.result.sourceHash, prep.sourceHash); assert.equal(effective.result.buildId, v.build.id);
  const rows = v.preStartReads; assert.ok(Array.isArray(rows) && rows.length >= 2 && rows.length <= 6);
  const expected = [];
  for (const operation of ['sts:get-caller-identity', 'codebuild:batch-get-projects']) {
    const group = rows.filter((r) => r.operation === operation);
    assert.ok(group.length >= 1 && group.length <= 3);
    group.forEach((r, i) => {
      assert.equal(r.attempt, i + 1); assert.ok(Number.isInteger(r.durationMs) && r.durationMs >= 0);
      assert.ok(Number.isInteger(r.elapsedMs) && r.elapsedMs >= r.durationMs && r.elapsedMs < 65000);
      if (i) assert.ok(r.elapsedMs >= group[i - 1].elapsedMs);
      assert.equal(r.result, i === group.length - 1 ? 'PASS' : 'FAIL');
      if (r.result === 'FAIL') assert.ok(transientFixtureRead({ code: r.failure.code }), 'ONLY_TEMPORARY_FAILURE_RECOVERY');
      expected.push(r);
    });
  }
  assert.deepEqual(rows, expected, 'FIXED_OPERATION_ORDER_REQUIRED');
  assert.ok(v.operations.length >= rows.length + 1);
  rows.forEach((r, i) => {
    const op = v.operations[i]; assert.equal(op.sequence, i + 1);
    assert.equal(op.operation, r.operation.split(':')[1]); assert.equal(op.profile, 'esgiot-infra'); assert.equal(op.result, r.result);
    if (r.result === 'FAIL') assert.deepEqual(op.failure, r.failure);
  });
  assert.ok(v.operations.slice(rows.length).every((r) => !['get-caller-identity', 'batch-get-projects'].includes(r.operation)));
  const starts = v.operations.filter((r) => r.operation === 'start-build');
  assert.equal(starts.length, 1); assert.equal(starts[0].result, 'PASS');
  const mutations = v.operations.filter((r) => ['create-project', 'update-project'].includes(r.operation));
  assert.ok(mutations.length <= 1 && mutations.every((r) => r.result === 'PASS' && r.sequence < starts[0].sequence));
  const failures = rows.filter((r) => r.result === 'FAIL').length;
  if (originalFailed) {
    assert.equal(failures, 0);
    assert.equal(v.preStartReadFailures, undefined); assert.equal(v.readGate, undefined); assert.equal(v.originalReadGate, undefined);
  } else {
    assert.equal(v.preStartReadFailures, failures);
    if (failures) { assert.equal(v.readGate, 'RECOVERED'); assert.equal(v.originalReadGate, 'FAIL'); }
    else assert.ok(['PASS', 'RECOVERED'].includes(v.readGate));
  }
  for (const [n, b] of [[name, bytes], [prepName, prepBytes], [startedName, startedBytes]]) bindings[n] = hash(b);
  observations.push({ receipt: name, action: prep.plan.action, prefix: prep.plan.prefix, buildId: v.build.id, attempts: rows.length, recoveredFailures: failures, originalClientGate: v.gate, effectiveResultGate: effective.gate });
}
const recoveredFailures = observations.reduce((sum, row) => sum + row.recoveredFailures, 0);
writeFileSync(output, JSON.stringify({ gate: 'PASS', scope: 'ORIGINAL_PRE_START_LEDGER_WITH_SEPARATE_EXACT_STARTED_BUILD_RESULT_RECOVERY', sourceCommit: '0afe48384537c8c79ec6ce87276858120b9fd6ef', mode, originalAuditClientGate: 'FAIL', effectiveAuditResultGate: 'PASS', newAuditBuildOnRecovery: false, observations, recoveredFailures, actualTransientRecovery: recoveredFailures ? 'OBSERVED' : 'NOT_TRIGGERED_NORMAL_PATH_ONLY', bindings, p95Accepted: false, fullQa09Accepted: false }, null, 2) + '\n');
console.log(JSON.stringify({ gate: 'PASS', mode, receipts: observations.length, recoveredFailures }));
