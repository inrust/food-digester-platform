import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLogReadBudget } from './check-qa09-log-read-budget.mjs';
const bindings = {
  sourceSha256: 's',
  collectorSha256: 'c',
  readerSha256: 'r',
  projectorSha256: 'p',
  priorSha256: 'a'.repeat(64),
};
function fixture() {
  const ids = Array.from({ length: 6 }, (_, i) => '10000000-0000-4000-8000-' + String(i).padStart(12, '0'));
  return {
    sourceReceiptSha256: 's',
    collectorSha256: 'c',
    readerSha256: 'r',
    observerProjectorSha256: 'p',
    gate: 'PASS',
    logReadErrors: {},
    exactLinkedCount: 6,
    records: ids.map((id) => ({ exactLinked: true, gateway: [{ integrationRequestId: id }] })),
    readOptimization: {
      scope: 'OWN_EXACT_GATEWAY_INTEGRATION_INVOCATIONS_ONLY',
      priorGatewayReceiptSha256: bindings.priorSha256,
      expectedPriorReceiptSha256: bindings.priorSha256,
      invocationIds: ids,
    },
    logReadBudget: {
      schemaVersion: 1,
      totalDeadlineMs: 120000,
      callTimeoutMs: 15000,
      maxCalls: 40,
      maxPagesPerQuery: 20,
      exactBatchSize: 3,
      readConcurrency: 1,
      automaticRetries: 0,
      elapsedMs: 20,
      error: null,
      attempts: [
        { group: 'gateway', query: 0 },
        { group: 'lambda', query: 0 },
        { group: 'lambda', query: 1 },
      ].map((a) => ({ ...a, page: 1, timeoutMs: 15000, elapsedMs: 1, result: 'PASS' })),
    },
  };
}
test('budget proof requires source bytes, every exact batch and full links without business/P95 claims', () => {
  const r = checkLogReadBudget(fixture(), bindings);
  assert.equal(r.gate, 'PASS');
  assert.equal(r.lambdaQueries, 2);
  assert.equal(r.fullQa09Accepted, false);
  assert.equal(r.targetBusinessAccepted, false);
});
for (const [name, mutate] of [
  [
    'source drift',
    (r) => {
      r.sourceReceiptSha256 = 'wrong';
    },
  ],
  [
    'collector drift',
    (r) => {
      r.collectorSha256 = 'wrong';
    },
  ],
  [
    'reader drift',
    (r) => {
      r.readerSha256 = 'wrong';
    },
  ],
  [
    'projector drift',
    (r) => {
      r.observerProjectorSha256 = 'wrong';
    },
  ],
  [
    'prior drift',
    (r) => {
      r.readOptimization.priorGatewayReceiptSha256 = 'wrong';
    },
  ],
  [
    'unbound expected prior',
    (r) => {
      r.readOptimization.expectedPriorReceiptSha256 = null;
    },
  ],
  [
    'partial gate',
    (r) => {
      r.gate = 'PARTIAL';
    },
  ],
  [
    'read error',
    (r) => {
      r.logReadBudget.error = 'LOG_READ_TIMEOUT';
    },
  ],
  [
    'group error',
    (r) => {
      r.logReadErrors.lambda = 'LOG_READ_TIMEOUT';
    },
  ],
  [
    'long timeout',
    (r) => {
      r.logReadBudget.attempts[0].timeoutMs = 45000;
    },
  ],
  [
    'larger batch',
    (r) => {
      r.logReadBudget.exactBatchSize = 12;
    },
  ],
  [
    'parallel reads',
    (r) => {
      r.logReadBudget.readConcurrency = 2;
    },
  ],
  [
    'retry',
    (r) => {
      r.logReadBudget.automaticRetries = 1;
    },
  ],
  [
    'expired total',
    (r) => {
      r.logReadBudget.elapsedMs = 120000;
    },
  ],
  [
    'missing batch',
    (r) => {
      r.logReadBudget.attempts.pop();
    },
  ],
  [
    'out of order page',
    (r) => {
      r.logReadBudget.attempts[1].page = 2;
    },
  ],
  [
    'out of order query',
    (r) => {
      r.logReadBudget.attempts[1].query = 1;
    },
  ],
  [
    'gateway after lambda',
    (r) => {
      r.logReadBudget.attempts.reverse();
    },
  ],
  [
    'wrong invocation',
    (r) => {
      r.records[0].gateway[0].integrationRequestId = 'wrong';
    },
  ],
  [
    'duplicate invocation',
    (r) => {
      r.readOptimization.invocationIds[1] = r.readOptimization.invocationIds[0];
    },
  ],
  [
    'missing link',
    (r) => {
      r.records[0].exactLinked = false;
    },
  ],
  [
    'wrong count',
    (r) => {
      r.exactLinkedCount = 5;
    },
  ],
]) {
  test('budget proof rejects ' + name, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => checkLogReadBudget(r, bindings));
  });
}
