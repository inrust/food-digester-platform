import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchedColdInputs } from './qa09-matched-cold-inputs.mjs';
import { analyzeContractLoadPair } from './analyze-qa09-contract-load.mjs';
import { validateContractLoadDetail } from './qa09-contract-load-detail-proof.mjs';
export function contractDetailInputs(sha) {
  const inputs = matchedColdInputs(sha);
  for (const unit of [inputs.r0, inputs.r1]) unit.contractLoadDetail = true;
  return {
    ...inputs,
    required: [
      ...inputs.required.map((r) =>
        r.replace(
          'actual runtime candidate config binding (not yet wired)',
          'actual guarded runtime candidate config binding',
        ),
      ),
      'explicit same detail=true hosted inputs/config for both units; final detail=false restore',
      'new strict ORM/pg child partitions and exactly one pg settlement',
    ],
    requireContractLoadSplit: true,
    requireContractLoadDetail: true,
  };
}
export function analyzeContractLoadDetailPair(off, on) {
  const files = [off, on],
    manifests = files.map((p) => JSON.parse(readFileSync(p)));
  if (!manifests.every((m) => m.requireContractLoadDetail === true && m.requireContractLoadSplit === true))
    throw Error('EXPLICIT_DETAIL_MANIFEST_REQUIRED');
  const base = analyzeContractLoadPair(off, on);
  const rows = manifests.map((m, i) =>
    JSON.parse(readFileSync(resolve(dirname(files[i]), m.receipts.patch.path)))
      .records.filter((c) => c.status === 409 && c.platformReports?.[0]?.initDurationMs > 0)
      .map((c) => ({
        requestId: c.requestId,
        lambdaRequestId: c.lambda[0].lambdaRequestId,
        ...validateContractLoadDetail(c.phases, c.contractLoadOwnership, true),
      })),
  );
  return {
    ...base,
    scope: 'BYTE_BOUND_SAME_SHA_ORM_RETURN_PG_SETTLEMENT_OBSERVATIONS_ONLY',
    detailRequired: true,
    detailR0: rows[0],
    detailR1: rows[1],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--prepare') {
    if (process.argv.length !== 5 || existsSync(process.argv[4])) throw Error('FRESH_SHA_OUTPUT_REQUIRED');
    writeFileSync(process.argv[4], JSON.stringify(contractDetailInputs(process.argv[3]), null, 2) + '\n');
  } else {
    if (process.argv.length !== 5 || existsSync(process.argv[4])) throw Error('FRESH_TWO_MANIFESTS_OUTPUT_REQUIRED');
    const result = analyzeContractLoadDetailPair(process.argv[2], process.argv[3]);
    writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ gate: result.gate, detailRequired: true }));
  }
}
