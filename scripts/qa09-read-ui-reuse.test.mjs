import test from 'node:test';
import assert from 'node:assert/strict';
import { canReuseReadUi } from './qa09-read-ui-reuse.mjs';
const allow = new Set(['read']);
const fixture = () => ({
  result: 'PASS',
  group: 'read',
  executions: [375, 1440].map((width) => ({
    width,
    role: 'PlatformSuperAdmin',
    result: 'PASS',
    requests: [{ method: 'GET', status: 200, requestId: 'actual' }],
  })),
});
test('Read-only historical evidence transfers only within unchanged source and current real read control', () => {
  assert.equal(canReuseReadUi(fixture(), allow, true, true), true);
  assert.equal(canReuseReadUi(fixture(), allow, false, true), false);
  assert.equal(canReuseReadUi(fixture(), allow, true, false), false);
});
test('A write, another role, missing request ID or viewport cannot be relabeled as a reusable read proof', () => {
  for (const mutate of [
    (e) => {
      e.executions[0].requests[0].method = 'POST';
    },
    (e) => {
      e.executions[0].role = 'CustomerViewer';
    },
    (e) => {
      e.executions[0].requests[0].requestId = null;
    },
    (e) => {
      e.executions[1].width = 375;
    },
    (e) => {
      e.group = 'mutating-workflow';
    },
  ]) {
    const e = fixture();
    mutate(e);
    assert.equal(canReuseReadUi(e, allow, true, true), false);
  }
});
