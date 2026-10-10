import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contractAwaitInputs, analyzeContractAwaitPair } from './analyze-qa09-contract-await.mjs';
import { validateContractPublicBoundaries } from './qa09-contract-public-proof.mjs';
export function contractPublicInputs(sha) {
  const base = contractAwaitInputs(sha);
  for (const unit of [base.r0, base.r1]) unit.contractPublicBoundaries = true;
  return {
    ...base,
    requireContractPublicBoundaries: true,
    restore: {
      expectedCommit: sha,
      rolloutPhase: 'immediate',
      engineCpuDiagnosis: true,
      authenticatedPreconnect: false,
      accountReadCandidate: false,
      contractLoadDetail: false,
      contractPublicBoundaries: false,
    },
    required: [
      ...base.required,
      'public=true bound to hosted inputs, actual Lambda config, same 19 ZIPs and strict child partitions in BOTH groups',
      'no forced yields or extra query(args) consumption; after-queue compiler seam unresolved',
      'same-SHA restore public/detail/account/preconnect=false and verify 19 artifacts, own empty/budget and Build terminal state',
    ],
  };
}
export function analyzeContractPublicPair(off, on) {
  const files = [off, on],
    manifests = files.map((p) => JSON.parse(readFileSync(p)));
  if (
    !manifests.every((m) => m.requireContractPublicBoundaries === true && m.inputs?.contractPublicBoundaries === true)
  )
    throw Error('EXPLICIT_PUBLIC_MANIFEST_REQUIRED');
  const base = analyzeContractAwaitPair(off, on);
  const rows = manifests.map((m, i) =>
    JSON.parse(readFileSync(resolve(dirname(files[i]), m.receipts.patch.path)))
      .records.filter((c) => c.status === 409 && c.platformReports?.[0]?.initDurationMs > 0)
      .map((c) => ({
        requestId: c.requestId,
        lambdaRequestId: c.lambda[0].lambdaRequestId,
        ...validateContractPublicBoundaries(c.phases, c.contractLoadOwnership, true),
      })),
  );
  if (rows.some((r) => r.length === 0)) throw Error('NATURAL_COLD_PUBLIC_REQUIRED');
  return {
    ...base,
    scope: 'BYTE_BOUND_SAME_SHA_PUBLIC_RETURN_AND_EXISTING_AWAIT_ONLY',
    publicRequired: true,
    publicR0: rows[0],
    publicR1: rows[1],
    forcedYields: 0,
    afterQueueAttribution: 'UNRESOLVED_NO_STABLE_COMPILER_SEAM',
    compilerOnlyAttribution: false,
    serverExecutionIsolated: false,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5 || existsSync(process.argv[4])) throw Error('FRESH_OUTPUT_REQUIRED');
  const result =
    process.argv[2] === '--prepare'
      ? contractPublicInputs(process.argv[3])
      : analyzeContractPublicPair(process.argv[2], process.argv[3]);
  writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n');
}
