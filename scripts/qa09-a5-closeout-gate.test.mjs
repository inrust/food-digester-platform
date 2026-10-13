import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateA5Closeout } from './check-qa09-a5-closeout.mjs';
import { sha256 } from './qa09-reliability-closeout.mjs';
const base = 'docs/audit/evidence/qa-09-close-07-2026-10-13/';
const read = (name) => JSON.parse(readFileSync(base + name));
test('historical SuperAdmin/empty-daily reliability evidence cannot close the new Operator and exact-production criteria', () => {
  const parent = read('target-v2.json'),
    r = read('target-v2.json.reliability.json'),
    final = read('final-readonly.json'),
    version = read('application-version.json');
  const hashes = {
    parent: sha256(readFileSync(base + 'target-v2.json')),
    version: sha256(readFileSync(base + 'application-version.json')),
  };
  for (const receipt of [
    r,
    {
      ...r,
      gate: 'PASS_SCOPED_RELIABILITY',
      replayProducerToSpecificSqsIdClaimed: true,
      operatorActorGate: 'PASS_REAL_OPERATOR_ACTOR',
      dedupGate: 'PASS_NO_RECEIPT_AGGREGATE_OR_ARCHIVE_DUPLICATION',
    },
  ]) {
    const result = evaluateA5Closeout(parent, receipt, final, version, hashes);
    assert.equal(result.gate, 'PARTIAL');
    assert.ok(result.closed.every((row) => row.status === 'NO_COMPLETE_RECEIPT'));
    assert.equal(result.fullQa09Accepted, false);
  }
});

test('sanitized actual wave closes only three criteria; corrupted actor, consumer, daily, version or recovery fails closed', () => {
  const fixture = () =>
    JSON.parse(readFileSync('docs/audit/evidence/qa-09-a2-a5-2026-10-13/a5-sanitized-regression-fixture.json'));
  const check = (f) => evaluateA5Closeout(f.parent, f.r, f.final, f.version, f.hashes);
  const result = check(fixture());
  assert.equal(result.gate, 'PASS_THREE_A5_SUPPLEMENTAL_CRITERIA');
  assert.equal(result.closed.length, 3);
  assert.equal(result.fullA5Accepted, false);
  assert.equal(result.fullQa09Accepted, false);
  assert.equal(result.originalExecutionGate, 'FAIL');
  for (const mutate of [
    (f) => {
      f.r.jobs[0].requestedBy = f.r.operator.userId;
    },
    (f) => {
      f.r.replayConsumption.rows = [];
    },
    (f) => {
      f.r.after.fingerprints.find((x) => x.table === 'telemetry_daily').count = '0';
    },
    (f) => {
      f.r.dailyWait.deviceId = f.r.before.devices[0].id;
    },
    (f) => {
      f.version.lambdaArtifacts[0].matches = false;
    },
    (f) => {
      f.hashes.recoveryFilesVerified = false;
    },
    (f) => {
      f.final.recovery.sha256 = '0'.repeat(64);
    },
    (f) => {
      f.r.jobs[0].role = 'PlatformSuperAdmin';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(check(f).gate, 'PARTIAL');
  }
});
