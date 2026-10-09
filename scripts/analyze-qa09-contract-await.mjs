import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contractDetailInputs, analyzeContractLoadDetailPair } from './analyze-qa09-contract-load-detail.mjs';
import { validateContractAwaitCheckpoint } from './qa09-contract-load-detail-proof.mjs';
export function contractAwaitInputs(sha) {
  const base = contractDetailInputs(sha);
  return {
    ...base,
    requireContractAwaitCheckpoint: true,
    contractReadCandidate: false,
    required: [
      ...base.required,
      'new same-SHA microtask checkpoint partition; do not promote old 465ms receipts',
      'native contract candidate remains offline-only and default false; no deployment switch',
      'R0 cleanup before R1; R1 cleanup before detail/preconnect/account false restore',
    ],
  };
}
export function analyzeContractAwaitPair(off, on) {
  const files = [off, on],
    manifests = files.map((p) => JSON.parse(readFileSync(p)));
  if (!manifests.every((m) => m.requireContractAwaitCheckpoint === true && m.contractReadCandidate === false))
    throw Error('EXPLICIT_AWAIT_MANIFEST_REQUIRED');
  const base = analyzeContractLoadDetailPair(off, on);
  const rows = manifests.map((m, i) =>
    JSON.parse(readFileSync(resolve(dirname(files[i]), m.receipts.patch.path)))
      .records.filter((c) => c.status === 409 && c.platformReports?.[0]?.initDurationMs > 0)
      .map((c) => ({
        requestId: c.requestId,
        lambdaRequestId: c.lambda[0].lambdaRequestId,
        ...validateContractAwaitCheckpoint(c.phases, c.contractLoadOwnership, true),
      })),
  );
  if (rows.some((r) => r.length === 0)) throw Error('NATURAL_COLD_AWAIT_REQUIRED');
  return {
    ...base,
    scope: 'BYTE_BOUND_SAME_SHA_PUBLIC_MICROTASK_WINDOWS_ONLY',
    awaitRequired: true,
    awaitR0: rows[0],
    awaitR1: rows[1],
    contractReadCandidate: false,
    compilerOnlyAttribution: false,
    p95Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--prepare') {
    if (process.argv.length !== 5 || existsSync(process.argv[4])) throw Error('FRESH_SHA_OUTPUT_REQUIRED');
    writeFileSync(process.argv[4], JSON.stringify(contractAwaitInputs(process.argv[3]), null, 2) + '\n');
  } else {
    if (process.argv.length !== 5 || existsSync(process.argv[4])) throw Error('FRESH_TWO_MANIFESTS_OUTPUT_REQUIRED');
    const r = analyzeContractAwaitPair(process.argv[2], process.argv[3]);
    writeFileSync(process.argv[4], JSON.stringify(r, null, 2) + '\n');
    console.log(JSON.stringify({ gate: r.gate, awaitRequired: true }));
  }
}
