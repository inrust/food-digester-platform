import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePhaseCorrelation } from './check-qa09-contract-phases.mjs';
import { analyzeAccountPhases } from './analyze-qa09-account-phases.mjs';
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
function accountFixtures() {
  const result = fixtures();
  for (const receipt of [result.patch, result.audit])
    for (const row of receipt.records)
      for (const [i, name] of [
        'admin-account-hook',
        'admin-account-query',
        'db-first-query',
        'db-first-connection',
      ].entries())
        row.phases.push({
          phase: name,
          durationMs: 10 - i * 2,
          outcome: 'PASS',
          errorCode: 'NONE',
          lambdaRequestId: row.requestId,
          gatewayRequestId: row.requestId,
          operationId: row.operationId,
          includesConnectionWait: true,
          startedAt: new Date(1000 + i).toISOString(),
          completedAt: new Date(1010 - i).toISOString(),
        });
  return result;
}
test('cold 409 gate requires matching cold phase flags and successful runtime initialization', () => {
  const { patch, audit } = accountFixtures();
  const options = { accountPhases: true, requireColdConflict: true };
  assert.throws(() => validatePhaseCorrelation(patch, audit, options), /COLD_CONFLICT_REQUIRED/);
  const row = patch.records[1];
  row.phases.forEach((p) => {
    p.coldStart = true;
  });
  row.phases.push({ ...row.phases[0], phase: 'runtime-initialize' });
  assert.equal(validatePhaseCorrelation(patch, audit, options).coldConflictObservedCount, 1);
  const analysis = analyzeAccountPhases(patch, audit);
  assert.equal(analysis.rows.length, 16);
  assert.equal(analysis.cleanupVerified, false);
  assert.equal(analysis.rows[1].accountNonDriverMs, 2);
  assert.equal(analysis.rows[1].driverNonConnectionMs, 2);
  assert.equal(analysis.rows[1].accountBeforeDriverMs, 1);
  // Hook contains account/driver/checkout, so only the hook contributes to the top-level sum.
  assert.equal(analysis.rows[1].topLevelMeasuredMs, 14);
  row.phases.push({ ...row.phases.at(-1) });
  assert.throws(() => validatePhaseCorrelation(patch, audit, options), /COLD_CONFLICT_REQUIRED/);
  row.phases.pop();
  row.phases[0].coldStart = false;
  assert.throws(() => validatePhaseCorrelation(patch, audit, options), /COLD_CONFLICT_REQUIRED/);
});
test('new account gate requires nested hook, Prisma query, first driver query and checkout on every request', () => {
  const { patch, audit } = accountFixtures();
  const r = validatePhaseCorrelation(patch, audit, { accountPhases: true });
  assert.equal(r.accountPhasesRequired, true);
  assert.equal(r.p95Accepted, false);
});
for (const fault of ['missing', 'duplicate', 'failure', 'wait-boundary', 'timestamp', 'outside-hook'])
  test('account gate rejects ' + fault, () => {
    const { patch, audit } = accountFixtures();
    const row = audit.records[0];
    const p = row.phases.find((p) => p.phase === 'db-first-connection');
    if (fault === 'missing') row.phases.splice(row.phases.indexOf(p), 1);
    if (fault === 'duplicate') row.phases.push({ ...p });
    if (fault === 'failure') p.outcome = 'FAIL';
    if (fault === 'wait-boundary') p.includesConnectionWait = false;
    if (fault === 'timestamp') p.startedAt = 'invalid';
    if (fault === 'outside-hook') p.completedAt = new Date(1050).toISOString();
    assert.throws(() => validatePhaseCorrelation(patch, audit, { accountPhases: true }));
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

function samplingFixtures() {
  const f = accountFixtures();
  f.patch.scope = 'OWN_COLD409_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION';
  f.audit.scope = 'OWN_COLD409_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION';
  f.audit.records.pop();
  for (const r of [...f.patch.records, ...f.audit.records]) {
    r.clientTransport = {
      source: 'NODE_HTTPS_SOCKET_EVENTS',
      socketAcquisitionMs: 0,
      requestSentAtMs: 2,
      headersAtMs: 3,
      bodyEndAtMs: 5,
      bodyReadMs: 2,
      jsonParseMs: 0,
      dnsMs: null,
      tcpMs: null,
      tlsMs: null,
      reusedSocket: true,
    };
    r.platformReports = [{ lambdaRequestId: r.lambda[0].lambdaRequestId, durationMs: 20, memoryMiB: 512 }];
  }
  const cold = f.patch.records[1];
  cold.phases.forEach((p) => {
    p.coldStart = true;
  });
  cold.phases.push({ ...cold.phases[0], phase: 'runtime-initialize' });
  cold.platformReports[0].initDurationMs = 800;
  return f;
}
test('bounded sampler requires physical Init Duration as well as application cold phases and retains client metrics', () => {
  const { patch, audit } = samplingFixtures();
  const options = { sampling: true, accountPhases: true, requireColdConflict: true };
  const proof = validatePhaseCorrelation(patch, audit, options);
  assert.equal(proof.coldConflictObservedCount, 1);
  assert.equal(proof.platformColdProofRequired, true);
  assert.equal(analyzeAccountPhases(patch, audit, { sampling: true }).rows[1].platformReport.initDurationMs, 800);
  delete patch.records[1].platformReports[0].initDurationMs;
  assert.throws(() => validatePhaseCorrelation(patch, audit, options), /COLD_CONFLICT_REQUIRED/);
});
for (const fault of [
  'foreign-report',
  'duplicate-report',
  'no-socket-metrics',
  'missing-body',
  'over-budget',
  'missing-audit',
])
  test('bounded sampler rejects ' + fault, () => {
    const { patch, audit } = samplingFixtures();
    if (fault === 'foreign-report') patch.records[1].platformReports[0].lambdaRequestId = 'foreign';
    if (fault === 'duplicate-report') patch.records[1].platformReports.push({ ...patch.records[1].platformReports[0] });
    if (fault === 'no-socket-metrics') delete audit.records[0].clientTransport;
    if (fault === 'missing-body') delete patch.records[0].clientTransport.bodyReadMs;
    if (fault === 'over-budget') patch.records.push(patch.records[0]);
    if (fault === 'missing-audit') audit.records.pop();
    assert.throws(() =>
      validatePhaseCorrelation(patch, audit, { sampling: true, accountPhases: true, requireColdConflict: true }),
    );
  });
