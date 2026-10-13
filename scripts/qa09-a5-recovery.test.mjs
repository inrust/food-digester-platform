import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertA5RecoveryInputs, assertOwnDisableDrift } from './recover-qa09-a5-cleanup.mjs';
const base = 'docs/audit/evidence/qa-09-a2-a5-2026-10-13/';
const fixture = () => JSON.parse(readFileSync(base + 'a5-sanitized-regression-fixture.json'));
const inputs = () => {
  const f = fixture();
  return [f.parent, f.r, f.actor];
};
test('only the observed nonexistent-read-route failure with exact terminal Replay and dedup can release recovery', () => {
  const args = inputs();
  assert.equal(assertA5RecoveryInputs(...args).jobId, args[1].jobs[0].jobId);
  for (const mutate of [
    (a) => {
      a[1].jobs[0].view.status = 'PENDING';
    },
    (a) => {
      a[1].replayConsumption.rows = [];
    },
    (a) => {
      a[1].after.fingerprints[0].count = '31';
    },
    (a) => {
      a[1].failure = 'UNKNOWN_WRITE';
    },
    (a) => {
      a[0].checks.find((c) => c.id === 'a5:operator-disable').status = 504;
    },
    (a) => {
      a[2].actorId = a[2].businessUserId;
    },
    (a) => {
      a[2].groups = ['PlatformSuperAdmin'];
    },
    (a) => {
      a[1].jobs.push(a[1].jobs[0]);
    },
  ]) {
    const changed = inputs();
    mutate(changed);
    assert.throws(() => assertA5RecoveryInputs(...changed), /EXACT_TERMINAL_A5_CLEANUP_FAILURE_REQUIRED/);
  }
});

test('resume allows only one published owned disable intent, not unrelated or unknown cleanup drift', () => {
  const [parent, r] = inputs();
  const f = fixture();
  const args = [f.prior, f.failed, f.drift, f.baseline, parent, r];
  assert.equal(assertOwnDisableDrift(...args).aggregate_id, r.operator.userId);
  for (const mutate of [
    (a) => {
      a[1].failure.startedBuildMayStillRun = true;
    },
    (a) => {
      a[2].result.outsideOutboxLedger[0].aggregate_id = 'foreign';
    },
    (a) => {
      a[2].result.businessFingerprints[1].digest = 'foreign';
    },
    (a) => {
      a[0].operatorCleanup.userId = 'foreign';
    },
  ]) {
    const changed = structuredClone(args);
    mutate(changed);
    assert.throws(() => assertOwnDisableDrift(...changed), /ONLY_EXACT_COMPLETED_OWN_DISABLE_DRIFT_ALLOWED/);
  }
});
