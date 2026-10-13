import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScopedSources, FORMAL_VALIDATORS } from './qa09-formal-closeout-map.mjs';
test('formal mapping cannot promote scoped evidence or cross version/prefix/cleanup boundaries', () => {
  const sourceCommit = 'a'.repeat(40),
    prefix = 'qa09-1234567890abcdef';
  const p = { sourceCommit, prefix, finishedAt: 'now' },
    c = { ...p, businessCleanup: 'PASS', fullQa09Accepted: false },
    f = { ...p, gate: 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' },
    v = { sourceCommit, gate: 'PASS', lambdaArtifacts: Array.from({ length: 19 }, () => ({ matches: true })) };
  assert.deepEqual(assertScopedSources(p, c, f, v), {
    fullQa09Accepted: false,
    productionReady: false,
    formalAccepted: false,
  });
  for (const mutate of [
    (x) => {
      x[0].cleanupHold = 'UNKNOWN';
    },
    (x) => {
      x[1].prefix = 'foreign';
    },
    (x) => {
      x[1].fullQa09Accepted = true;
    },
    (x) => {
      x[1].businessCleanup = 'FAIL';
    },
    (x) => {
      x[2].gate = 'FAIL';
    },
    (x) => {
      x[3].sourceCommit = 'b'.repeat(40);
    },
    (x) => {
      x[3].lambdaArtifacts.pop();
    },
    (x) => {
      x.forEach((row) => {
        row.sourceCommit = undefined;
      });
    },
    (x) => {
      x.slice(0, 3).forEach((row) => {
        row.prefix = 'foreign';
      });
    },
  ]) {
    const x = structuredClone([p, c, f, v]);
    mutate(x);
    assert.throws(() => assertScopedSources(...x), /BINDING/);
  }
  assert.equal(FORMAL_VALIDATORS.length, 8);
  assert.equal(new Set(FORMAL_VALIDATORS).size, 8);
});
