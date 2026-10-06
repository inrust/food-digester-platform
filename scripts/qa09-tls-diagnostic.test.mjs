import test from 'node:test';
import assert from 'node:assert/strict';
import { runTlsDiagnostic } from './qa09-tls-diagnostic.mjs';
const row = (mode, index) => ({
  mode,
  index,
  status: 401,
  responseReceived: true,
  clientTransport: { phase: 'COMPLETE', reusedSocket: mode === 'pooled' && index > 1 },
  tls: { authorized: true, protocol: 'TLSv1.3' },
});
test('TLS diagnostic bounds independent reads to 12 and six concurrent; fake observations cannot claim real target source', async () => {
  let active = 0,
    peak = 0;
  const calls = [];
  const r = await runTlsDiagnostic({
    perform: async (mode, index, agent) => {
      active++;
      peak = Math.max(peak, active);
      calls.push([mode, index]);
      assert.equal(agent.maxTotalSockets, 6);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return row(mode, index);
    },
  });
  assert.equal(calls.length, 12);
  assert.equal(peak, 6);
  assert.equal(r.peakConcurrency, 6);
  assert.equal(r.gate, 'PASS');
  assert.equal(r.reuseComparisonGate, 'PASS');
  assert.equal(r.source, 'CONTROLLED_TEST_ONLY');
  assert.equal(r.p95Accepted, false);
  assert.deepEqual(
    calls.slice(0, 6).map((x) => x[0]),
    ['new-session', 'new-session', 'new-session', 'pooled', 'pooled', 'pooled'],
  );
});
test('TLS diagnostic retains settled siblings, missing samples and unexpected HTTP/authentication as PARTIAL', async () => {
  const r = await runTlsDiagnostic({
    perform: async (mode, index) => {
      if (mode === 'parallel' && index === 2) throw Error('private data');
      return { ...row(mode, index), status: index === 3 ? 500 : 401 };
    },
  });
  assert.equal(r.gate, 'PARTIAL');
  assert.equal(r.rows.length, 11);
  assert.equal(r.orchestrationFailure, true);
  assert.equal(JSON.stringify(r).includes('private data'), false);
  const bad = await runTlsDiagnostic({
    perform: async (mode, index) => ({ ...row(mode, index), tls: { authorized: false, protocol: 'TLSv1.3' } }),
  });
  assert.equal(bad.gate, 'PARTIAL');
  const noReuse = await runTlsDiagnostic({
    perform: async (mode, index) => ({
      ...row(mode, index),
      clientTransport: { phase: 'COMPLETE', reusedSocket: false },
    }),
  });
  assert.equal(noReuse.reuseComparisonGate, 'NOT_OBSERVED');
});
