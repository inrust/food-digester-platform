const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
export function validateColdSamplingReceipt(child) {
  const r = child.cold409Sampling;
  demand(
    child.gate === 'PASS' &&
      child.cleanupComplete === true &&
      /^qa09-[a-f0-9]{16}$/.test(child.prefix) &&
      child.fullQa09Accepted === false,
    'COLD_SAMPLING_FINAL_CHILD_REQUIRED',
  );
  demand(
    r?.scope === 'OWN_DRAFT_COLD409_BOUNDED_SAMPLING' &&
      r.gate === 'PASS' &&
      r.coldGate === 'NOT_EVALUATED' &&
      [1, 2].includes(r.configuredBatches) &&
      r.maxConcurrency === 6 &&
      r.maxPatchRequests === 12,
    'COLD_SAMPLING_BUDGET_REQUIRED',
  );
  demand(
    r.attempts.length === 6 * r.configuredBatches &&
      r.contracts.length === 3 * r.configuredBatches &&
      r.batches.length === r.configuredBatches &&
      new Set(r.attempts.map((a) => a.clientRequestId)).size === r.attempts.length &&
      new Set(r.contracts.map((c) => c.contractId)).size === r.contracts.length,
    'COLD_SAMPLING_COUNTS',
  );
  demand(
    r.checks.length > 0 &&
      r.checks.every((c) => c.result === 'PASS') &&
      r.batches.every(
        (b, i) => b.batch === i + 1 && b.settled.length === 6 && b.settled.every((x) => x === 'fulfilled'),
      ),
    'COLD_SAMPLING_UNSETTLED',
  );
  for (const c of r.contracts) {
    const pair = r.attempts.filter((a) => a.contractId === c.contractId);
    const winner = pair.find((a) => a.observation?.status === 200),
      loser = pair.find((a) => a.observation?.status === 409);
    demand(
      c.name === `${child.prefix}-cold-${c.batch}-${c.index}` &&
        c.customerId === child.customers[0].id &&
        c.status === 'DRAFT' &&
        c.version === 1 &&
        c.readback?.version === 2 &&
        c.readback.status === 'DRAFT' &&
        c.readback.name === winner?.name,
      'COLD_SAMPLING_CONTRACT_SCOPE',
    );
    demand(
      pair.length === 2 &&
        new Set(pair.map((a) => a.side)).size === 2 &&
        winner &&
        loser &&
        loser.observation.errorCode === 'VERSION_CONFLICT' &&
        pair.every(
          (a) =>
            a.batch === c.batch &&
            a.index === c.index &&
            ['a', 'b'].includes(a.side) &&
            a.path === '/api/v1/admin/contracts/' + c.contractId &&
            a.method === 'PATCH' &&
            a.ifMatch === 1 &&
            a.name === `${c.name}-${a.side}` &&
            a.state === 'SETTLED' &&
            a.observation.responseReceived === true &&
            a.observation.gatewayRequestId === a.clientRequestId,
        ),
      'COLD_SAMPLING_PAIR',
    );
    for (const a of pair) {
      const audit = r.audit.filter((x) => x.requestId === a.clientRequestId && x.contractId === c.contractId);
      demand(
        audit.length === 1 &&
          audit[0].result === (a === winner ? 'SUCCESS' : 'FAILURE') &&
          audit[0].beforeVersion === 1 &&
          (a !== winner || audit[0].afterVersion === 2),
        'COLD_SAMPLING_AUDIT',
      );
    }
  }
  demand(
    r.audit.length === r.attempts.length && new Set(r.audit.map((a) => a.auditId)).size === r.audit.length,
    'COLD_SAMPLING_AUDIT_COUNT',
  );
  return r;
}

export function validateSamplingCorrelationLedger(child, patch, audit) {
  const sample = validateColdSamplingReceipt(child);
  const reads = child.checks.filter((c) => c.method === 'GET' && c.id.startsWith('cold:audit'));
  demand(
    patch.records.length === sample.attempts.length &&
      new Set(patch.records.map((r) => r.requestId)).size === sample.attempts.length &&
      patch.records.every((row) =>
        sample.attempts.some((a) => a.clientRequestId === row.requestId && a.observation.status === row.status),
      ),
    'SAMPLING_LEDGER_BINDING',
  );
  demand(
    reads.length === 9 * sample.configuredBatches &&
      audit.records.length === reads.length &&
      new Set(audit.records.map((r) => r.requestId)).size === reads.length &&
      audit.records.every((row) =>
        reads.some((c) => c.gatewayRequestId === row.requestId && c.id === row.id && c.status === row.status),
      ),
    'SAMPLING_AUDIT_LEDGER_BINDING',
  );
  return sample;
}
