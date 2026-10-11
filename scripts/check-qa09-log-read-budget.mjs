import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const demand = (value, code) => {
  if (!value) throw Error(code);
};
export function checkLogReadBudget(receipt, bindings) {
  demand(receipt.sourceReceiptSha256 === bindings.sourceSha256, 'LOG_SOURCE_DRIFT');
  demand(receipt.collectorSha256 === bindings.collectorSha256, 'LOG_COLLECTOR_DRIFT');
  demand(receipt.readerSha256 === bindings.readerSha256, 'LOG_READER_DRIFT');
  demand(receipt.observerProjectorSha256 === bindings.projectorSha256, 'LOG_PROJECTOR_DRIFT');
  const b = receipt.logReadBudget;
  demand(
    b?.schemaVersion === 1 &&
      b.totalDeadlineMs === 120000 &&
      b.callTimeoutMs === 15000 &&
      b.maxCalls === 40 &&
      b.maxPagesPerQuery === 20 &&
      b.exactBatchSize === 3 &&
      b.readConcurrency === 1 &&
      b.automaticRetries === 0,
    'LOG_BUDGET_REQUIRED',
  );
  demand(
    receipt.gate === 'PASS' && b.error === null && Object.keys(receipt.logReadErrors ?? { missing: true }).length === 0,
    'LOG_READ_INCOMPLETE',
  );
  demand(Number.isInteger(b.elapsedMs) && b.elapsedMs >= 0 && b.elapsedMs < 120000, 'LOG_DEADLINE_REQUIRED');
  demand(Array.isArray(b.attempts) && b.attempts.length > 0 && b.attempts.length <= 40, 'LOG_ATTEMPT_LIMIT');
  const queryPages = new Map();
  let lambdaStarted = false,
    lastQuery = -1;
  for (const a of b.attempts) {
    demand(a.group === 'gateway' || a.group === 'lambda', 'LOG_GROUP_REQUIRED');
    demand(!lambdaStarted || a.group === 'lambda', 'LOG_GROUP_ORDER');
    lambdaStarted ||= a.group === 'lambda';
    demand(Number.isInteger(a.query) && a.query >= 0 && (a.group !== 'gateway' || a.query === 0), 'LOG_QUERY_REQUIRED');
    if (a.group === 'lambda') {
      demand(a.query === lastQuery || a.query === lastQuery + 1, 'LOG_QUERY_ORDER');
      lastQuery = a.query;
    }
    const key = `${a.group}:${a.query}`,
      next = (queryPages.get(key) ?? 0) + 1;
    demand(a.page === next && next <= 20, 'LOG_PAGE_ORDER');
    queryPages.set(key, next);
    demand(
      a.result === 'PASS' &&
        a.error === undefined &&
        Number.isInteger(a.timeoutMs) &&
        a.timeoutMs > 0 &&
        a.timeoutMs <= 15000 &&
        Number.isInteger(a.elapsedMs) &&
        a.elapsedMs >= 0,
      'LOG_ATTEMPT_REQUIRED',
    );
  }
  const exact = receipt.readOptimization;
  let lambdaQueries = 1;
  if (exact) {
    demand(
      exact.scope === 'OWN_EXACT_GATEWAY_INTEGRATION_INVOCATIONS_ONLY' &&
        exact.priorGatewayReceiptSha256 === bindings.priorSha256 &&
        exact.expectedPriorReceiptSha256 === bindings.priorSha256 &&
        /^[a-f0-9]{64}$/.test(bindings.priorSha256 ?? ''),
      'LOG_PRIOR_DRIFT',
    );
    demand(
      Array.isArray(exact.invocationIds) &&
        exact.invocationIds.length > 0 &&
        exact.invocationIds.length <= 19 &&
        new Set(exact.invocationIds).size === exact.invocationIds.length &&
        exact.invocationIds.every((v) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)),
      'LOG_INVOCATIONS_REQUIRED',
    );
    demand(
      receipt.records?.length === exact.invocationIds.length &&
        receipt.records.every(
          (r, i) => r.gateway?.length === 1 && r.gateway[0].integrationRequestId === exact.invocationIds[i],
        ),
      'LOG_INVOCATION_BINDING',
    );
    lambdaQueries = Math.ceil(exact.invocationIds.length / 3);
  } else demand(bindings.priorSha256 === undefined, 'LOG_UNEXPECTED_PRIOR');
  demand(
    queryPages.has('gateway:0') && queryPages.size === lambdaQueries + 1 && lastQuery === lambdaQueries - 1,
    'LOG_QUERIES_INCOMPLETE',
  );
  demand(
    receipt.records?.length > 0 &&
      receipt.records.every((r) => r.exactLinked === true) &&
      receipt.exactLinkedCount === receipt.records.length,
    'LOG_LINKS_INCOMPLETE',
  );
  return {
    gate: 'PASS',
    scope: 'BOUNDED_READ_RECEIPT_AND_SOURCE_BYTES',
    calls: b.attempts.length,
    lambdaQueries,
    fullQa09Accepted: false,
    targetBusinessAccepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, correlation, prior] = process.argv.slice(2);
  demand(source && correlation && process.argv.length <= 5, 'LOG_RECEIPT_PATHS_REQUIRED');
  const result = checkLogReadBudget(JSON.parse(readFileSync(correlation)), {
    sourceSha256: hash(readFileSync(source)),
    collectorSha256: hash(readFileSync('scripts/collect-qa09-contract-correlation.py')),
    readerSha256: hash(readFileSync('scripts/qa09_log_read.py')),
    projectorSha256: hash(readFileSync('scripts/qa09_observer_cost.py')),
    ...(prior ? { priorSha256: hash(readFileSync(prior)) } : {}),
  });
  console.log(JSON.stringify(result));
}
