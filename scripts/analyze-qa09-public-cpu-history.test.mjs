import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionTransport } from './analyze-qa09-public-cpu-history.mjs';
const receipt = () => ({
  latencyMs: 510,
  clientTransport: {
    source: 'NODE_HTTPS_SOCKET_EVENTS',
    reusedSocket: true,
    dnsMs: null,
    tcpMs: null,
    tlsMs: null,
    socketAcquisitionMs: 1,
    requestSentAtMs: 2,
    headersAtMs: 500,
    bodyEndAtMs: 502,
    responseWaitMs: 498,
    bodyReadMs: 2,
    jsonParseMs: 1,
  },
});
test('disjoint event partition conserves total; reuse nulls are retained', () => {
  const p = partitionTransport(receipt());
  assert.equal(p.tcpMs, null);
  assert.equal(p.longTail, false);
  assert.equal(
    p.acquisitionMs + p.acquisitionToSentMs + p.sentToHeadersMs + p.headersToEndMs + p.endToClientCompletionMs,
    510,
  );
});
for (const [name, mutate, code] of [
  [
    'inverted events',
    (r) => {
      r.clientTransport.headersAtMs = 0;
    },
    'HISTORY_TRANSPORT_ORDER',
  ],
  [
    'inconsistent delta',
    (r) => {
      r.clientTransport.responseWaitMs = 200;
    },
    'HISTORY_TRANSPORT_CONSERVATION',
  ],
  [
    'invalid missing tcp',
    (r) => {
      delete r.clientTransport.tcpMs;
    },
    'HISTORY_NULL_IS_NOT_ZERO',
  ],
  [
    'negative total',
    (r) => {
      r.latencyMs = 2;
    },
    'HISTORY_TRANSPORT_TOTAL',
  ],
  [
    'wrong source',
    (r) => {
      r.clientTransport.source = 'ASSUMED';
    },
    'HISTORY_TRANSPORT_SOURCE',
  ],
])
  test(`reject ${name}`, () => {
    const r = receipt();
    mutate(r);
    assert.throws(() => partitionTransport(r), new RegExp(code));
  });
test('TCP/TLS details are retained without adding overlapping durations', () => {
  const r = receipt();
  r.clientTransport.reusedSocket = false;
  r.clientTransport.tcpMs = 3000;
  r.clientTransport.tlsMs = 1000;
  assert.equal(partitionTransport(r).longTail, true);
  assert.equal(partitionTransport(r).sentToHeadersMs, 498);
});
