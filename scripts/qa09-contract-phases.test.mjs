import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePhaseCorrelation } from './check-qa09-contract-phases.mjs';
function fixtures() {
  const make = (scope, audit) => ({
    scope,
    gate: 'PASS',
    sourceReceiptSha256: 'hash',
    sourceCommit: 'commit',
    prefix: 'prefix',
    logReadErrors: {},
    records: Array.from({ length: audit ? 10 : 6 }, (_, i) => {
      const id = (audit ? 'audit' : 'patch') + i,
        conflict = !audit && i % 2 === 1,
        op = audit ? (i ? 'getAuditLogDetail' : 'listAuditLogs') : 'updateContract';
      const row = {
        id,
        requestId: id,
        method: audit ? 'GET' : 'PATCH',
        operationId: op,
        status: conflict ? 409 : 200,
        responseReceived: true,
        exactLinked: true,
        gateway: [{ responseLatency: 20 }],
        lambda: [{ lambdaRequestId: id, operationId: op, elapsedMs: 10 }],
        phases: [],
      };
      const phase = (name, outcome = 'PASS', errorCode = 'NONE') =>
        row.phases.push({
          phase: name,
          durationMs: 1,
          outcome,
          errorCode,
          lambdaRequestId: id,
          gatewayRequestId: id,
          operationId: op,
        });
      phase('admin-authenticate');
      if (audit) {
        phase(i ? 'audit-detail-query' : 'audit-list-query');
        phase('audit-view');
      } else {
        phase('db-transaction-open');
        phase('contract-load');
        for (const name of [
          'contract-version-update',
          'db-transaction-callback',
          'db-transaction-finish',
          'db-transaction',
        ])
          phase(name, conflict ? 'FAIL' : 'PASS', conflict ? 'VERSION_CONFLICT' : 'NONE');
        if (conflict) phase('audit-failure-write');
        else {
          phase('contract-readback');
          phase('audit-success-write');
        }
      }
      return row;
    }),
  });
  return {
    patch: make('OWN_CONTRACT_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION', false),
    audit: make('OWN_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION', true),
  };
}
test('phase proof covers success, conditional conflict and all audit reads without declaring latency/cleanup acceptance', () => {
  const { patch, audit } = fixtures();
  const r = validatePhaseCorrelation(patch, audit);
  assert.equal(r.gate, 'PASS');
  assert.equal(r.summaries.length, 16);
  assert.equal(r.cleanupVerified, false);
  assert.equal(r.p95Accepted, false);
});
for (const fault of ['foreign-invocation', 'missing-transaction', 'conflict-code', 'missing-http', 'other-run'])
  test('phase proof rejects ' + fault, () => {
    const { patch, audit } = fixtures();
    if (fault === 'foreign-invocation') patch.records[0].phases[0].lambdaRequestId = 'foreign';
    if (fault === 'missing-transaction') patch.records[0].phases.pop();
    if (fault === 'conflict-code')
      patch.records[1].phases.find((p) => p.phase === 'contract-version-update').errorCode = 'DATA_PATH_PHASE_FAILED';
    if (fault === 'missing-http') audit.records[1].responseReceived = false;
    if (fault === 'other-run') audit.sourceReceiptSha256 = 'other';
    assert.throws(() => validatePhaseCorrelation(patch, audit));
  });
