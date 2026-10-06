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
function preparationFixtures() {
  const r = accountFixtures();
  for (const c of [...r.patch.records, ...r.audit.records]) {
    const template = c.phases.find((p) => p.phase === 'admin-account-query');
    c.phases.push({
      ...template,
      phase: 'db-client-prepare',
      durationMs: 1,
      includesConnectionWait: false,
      startedAt: new Date(1001).toISOString(),
      completedAt: new Date(1002).toISOString(),
      completionBoundary: 'DRIVER_DISPATCH',
    });
  }
  const cold = r.patch.records[1];
  cold.phases.forEach((p) => (p.coldStart = true));
  cold.phases.push(
    { ...cold.phases[0], phase: 'runtime-initialize' },
    {
      ...cold.phases.at(-1),
      phase: 'db-adapter-connect',
      durationMs: 0,
      includesConnectionWait: false,
      startedAt: new Date(1001).toISOString(),
      completedAt: new Date(1001).toISOString(),
    },
    {
      ...cold.phases.at(-1),
      phase: 'db-client-after-adapter',
      durationMs: 1,
      includesConnectionWait: false,
      startedAt: new Date(1001).toISOString(),
      completedAt: new Date(1002).toISOString(),
      completionBoundary: 'DRIVER_DISPATCH',
    },
  );
  return r;
}
test('client preparation requires actual dispatch, cold adapter suffix and leaves warm adapter timings absent', () => {
  const { patch, audit } = preparationFixtures();
  const proof = validatePhaseCorrelation(patch, audit, {
    accountPhases: true,
    clientPreparation: true,
    requireColdConflict: true,
  });
  assert.equal(proof.clientPreparationRequired, true);
  const a = analyzeAccountPhases(patch, audit, { clientPreparation: true });
  assert.equal(a.rows[1].clientPreparationMs, 1);
  assert.equal(a.rows[1].afterAdapterMs, 1);
  assert.equal(a.rows[0].adapterConnectMs, null);
  assert.equal(a.rows[0].afterAdapterMs, null);
  assert.equal(a.rows[1].topLevelMeasuredMs, 14, 'nested preparation must not be summed with account hook');
});
for (const [name, mutate, reason] of [
  ['missing prepare', (c) => (c.phases = c.phases.filter((p) => p.phase !== 'db-client-prepare')), /PHASE_MISSING/],
  [
    'settlement is not driver dispatch',
    (c) => (c.phases.find((p) => p.phase === 'db-client-prepare').completionBoundary = 'OPERATION_SETTLED'),
    /CLIENT_PREPARATION_BOUNDARY/,
  ],
  [
    'preparation after driver start',
    (c) => (c.phases.find((p) => p.phase === 'db-client-prepare').completedAt = new Date(1004).toISOString()),
    /CLIENT_PREPARATION_BOUNDARY/,
  ],
  [
    'cold missing suffix',
    (c) => (c.phases = c.phases.filter((p) => p.phase !== 'db-client-after-adapter')),
    /CLIENT_ADAPTER_PHASES/,
  ],
  [
    'suffix outside preparation',
    (c) => (c.phases.find((p) => p.phase === 'db-client-after-adapter').completedAt = new Date(1003).toISOString()),
    /CLIENT_ADAPTER_PHASE_NOT_NESTED/,
  ],
  [
    'wrong invocation',
    (c) => (c.phases.find((p) => p.phase === 'db-client-prepare').lambdaRequestId = 'foreign'),
    /PHASE_ID_MISMATCH/,
  ],
])
  test('client preparation rejects ' + name, () => {
    const { patch, audit } = preparationFixtures();
    mutate(patch.records[1]);
    assert.throws(
      () => validatePhaseCorrelation(patch, audit, { accountPhases: true, clientPreparation: true }),
      reason,
    );
  });
test('client preparation cannot bypass account phase checks', () => {
  const { patch, audit } = preparationFixtures();
  assert.throws(
    () => validatePhaseCorrelation(patch, audit, { clientPreparation: true }),
    /CLIENT_PREPARATION_REQUIRES_ACCOUNT_PHASES/,
  );
});

function engineFixtures() {
  const { patch, audit } = accountFixtures();
  for (const r of [patch, audit])
    for (const c of r.records) {
      for (const p of c.phases) {
        p.coldStart = false;
        if (p.phase === 'admin-account-hook') {
          p.startedAt = new Date(900).toISOString();
          p.durationMs = 110;
        }
        if (p.phase === 'admin-account-query')
          Object.assign(p, { processCpuUserUs: 50, processCpuSystemUs: 10, processCpuScope: 'PROCESS_ALL_THREADS' });
      }
      const base = {
        lambdaRequestId: c.lambda[0].lambdaRequestId,
        gatewayRequestId: c.requestId,
        operationId: c.lambda[0].operationId,
        coldStart: false,
        outcome: 'PASS',
        errorCode: 'NONE',
        includesConnectionWait: false,
      };
      const add = (phase, start, end, boundary, cpu = false) =>
        c.phases.push({
          ...base,
          phase,
          durationMs: end - start,
          startedAt: new Date(start).toISOString(),
          completedAt: new Date(end).toISOString(),
          ...(boundary ? { completionBoundary: boundary } : {}),
          ...(cpu ? { processCpuUserUs: 50, processCpuSystemUs: 10, processCpuScope: 'PROCESS_ALL_THREADS' } : {}),
        });
      add('db-engine-prepare', 910, 990, 'OPERATION_SETTLED', true);
      add('db-adapter-connect', 911, 912);
      add('db-engine-after-adapter', 912, 990, 'OPERATION_SETTLED', true);
      add('db-client-prepare', 1001, 1002, 'DRIVER_DISPATCH');
    }
  return { patch, audit };
}
test('engine CPU mode proves preparation before model, preserves driver boundary and refuses old lazy ownership', () => {
  const { patch, audit } = engineFixtures();
  const options = { accountPhases: true, clientPreparation: true, engineCpu: true };
  assert.equal(validatePhaseCorrelation(patch, audit, options).gate, 'PASS');
  assert.throws(() => validatePhaseCorrelation(patch, audit, { accountPhases: true, clientPreparation: true }));
  for (const mutate of [
    (c) => {
      c.phases.find((p) => p.phase === 'admin-account-query').processCpuUserUs = -1;
    },
    (c) => {
      c.phases.find((p) => p.phase === 'db-engine-prepare').completedAt = new Date(1005).toISOString();
    },
    (c) => {
      c.phases.find((p) => p.phase === 'db-engine-after-adapter').completionBoundary = 'DRIVER_DISPATCH';
    },
    (c) => {
      c.phases = c.phases.filter((p) => p.phase !== 'db-engine-prepare');
    },
    (c) => {
      c.phases.find((p) => p.phase === 'db-first-connection').startedAt = new Date(920).toISOString();
    },
  ]) {
    const f = engineFixtures();
    mutate(f.patch.records[0]);
    assert.throws(() => validatePhaseCorrelation(f.patch, f.audit, options));
  }
});
