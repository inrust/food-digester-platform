import test from 'node:test';
import assert from 'node:assert/strict';
import { p95, completeP95 } from './qa09-performance-probes.mjs';
test('P95 uses all actual samples and rejects empty or invalid measurements', () => {
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19);
  assert.equal(p95([11980, 3000, 1000]), 11980);
  for (const samples of [[], [NaN], [-1], [Infinity]]) assert.throws(() => p95(samples));
});

test('complete P95 excludes censored timeouts and refuses partial sample acceptance', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({ visible: true, latencyMs: i + 1 }));
  assert.equal(completeP95(samples, 'visible'), 19);
  assert.equal(completeP95(samples.slice(1), 'visible'), null);
  assert.equal(completeP95([...samples.slice(1), { visible: false, latencyMs: 30001 }], 'visible'), null);
  assert.equal(completeP95([...samples.slice(1), { visible: true, latencyMs: NaN }], 'visible'), null);
});
