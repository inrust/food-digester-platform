import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMatchedColdUnit, validateMatchedColdPair } from './qa09-matched-cold-inputs.mjs';
import { validateContractLoadSplit } from './qa09-contract-load-proof.mjs';
const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
export function summarizeContractLoadRequest(c) {
  demand(
    c.exactLinked === true &&
      c.status === 409 &&
      c.lambda?.length === 1 &&
      c.gateway?.length === 1 &&
      c.platformReports?.length === 1 &&
      c.platformReports[0].initDurationMs > 0 &&
      c.platformReports[0].lambdaRequestId === c.lambda[0].lambdaRequestId &&
      c.gateway[0].integrationRequestId === c.lambda[0].lambdaRequestId,
    'EXACT_PHYSICAL_COLD_LOAD_REQUIRED',
  );
  const split = validateContractLoadSplit(c.phases, c.contractLoadOwnership, true);
  demand(
    c.phases.every(
      (p) =>
        p.lambdaRequestId === c.lambda[0].lambdaRequestId &&
        p.gatewayRequestId === c.requestId &&
        p.operationId === 'updateContract',
    ),
    'LOAD_REQUEST_IDS',
  );
  const one = (name) => {
    const p = c.phases.filter((p) => p.phase === name);
    demand(p.length === 1 && p[0].outcome === 'PASS' && Number.isFinite(p[0].durationMs), 'ACCOUNT_CONTEXT_REQUIRED');
    return p[0].durationMs;
  };
  return {
    requestId: c.requestId,
    lambdaRequestId: c.lambda[0].lambdaRequestId,
    ...split,
    accountQueryMs: one('admin-account-query'),
    accountHookMs: one('admin-account-hook'),
    applicationMs: c.lambda[0].elapsedMs,
    initMs: c.platformReports[0].initDurationMs,
  };
}
export function analyzeContractLoadPair(offFile, onFile) {
  const files = [offFile, onFile];
  const manifests = files.map((file) => JSON.parse(readFileSync(file)));
  demand(
    manifests.every((m) => m.requireContractLoadSplit === true),
    'EXPLICIT_CONTRACT_LOAD_SPLIT_REQUIRED',
  );
  const units = files.map(readMatchedColdUnit);
  const pair = validateMatchedColdPair(...units);
  const summaries = manifests.map((m, i) =>
    JSON.parse(readFileSync(resolve(dirname(files[i]), m.receipts.patch.path)))
      .records.filter((c) => c.status === 409 && c.platformReports?.[0]?.initDurationMs > 0)
      .map(summarizeContractLoadRequest),
  );
  return {
    gate: 'OBSERVATIONS_ONLY',
    scope: 'BYTE_BOUND_SAME_SHA_PUBLIC_CONTRACT_LOAD_WINDOWS',
    sourceCommit: pair.sourceCommit,
    matchedInputGate: pair.gate,
    receiptBytesVerified: true,
    receiptBindings: units.map((u) => u.receiptBindings),
    coldProofGroup: units[0].coldProofGroup,
    r0: summaries[0],
    r1: summaries[1],
    modelCostShift: 'NOT_ESTABLISHED_COMPILER_ONLY_ATTRIBUTION_UNAVAILABLE',
    causalBenefit: 'NOT_ESTABLISHED',
    processCpuScope: 'PROCESS_ALL_THREADS',
    serverExecutionIsolated: false,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [off, on, output] = process.argv.slice(2);
  demand(process.argv.length === 5, 'TWO_MATCHED_MANIFESTS_AND_OUTPUT_REQUIRED');
  const result = analyzeContractLoadPair(off, on);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      gate: result.gate,
      matchedInputGate: result.matchedInputGate,
      r0: result.r0.length,
      r1: result.r1.length,
    }),
  );
}
