import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchedColdInputs, readMatchedColdUnit, validateMatchedColdPair } from './qa09-matched-cold-inputs.mjs';
import { contractObserverInputs } from './qa09-contract-observer-proof.mjs';
export function observerTargetInputs(sha, { ownedBoundaries = false } = {}) {
  const input = contractObserverInputs(sha),
    base = matchedColdInputs(sha);
  return {
    ...input,
    gate: 'PREPARED_OFFLINE_TARGET_NOT_RUN',
    r0: { ...base.r0, ...input.r0 },
    r1: { ...base.r0, ...input.r1 },
    manifestRequirements: {
      requireContractLoadSplit: true,
      requireContractLoadDetail: true,
      requireContractAwaitCheckpoint: true,
      requireContractPublicBoundaries: true,
      requireContractObserverCost: true,
      ...(ownedBoundaries ? { requireOwnedBoundaries: true } : {}),
    },
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
export function analyzeObserverPair(off, on, { ownedBoundaries = false } = {}) {
  for (const path of [off, on]) {
    const m = JSON.parse(readFileSync(path));
    if (ownedBoundaries && m.requireOwnedBoundaries !== true) throw Error('OWNED_MANIFEST_REQUIRED');
    if (m.requireContractObserverCost !== true) throw Error('OBSERVER_MANIFEST_REQUIRED');
  }
  const r0 = readMatchedColdUnit(off),
    r1 = readMatchedColdUnit(on);
  return {
    ...validateMatchedColdPair(r0, r1, { observerCost: true }),
    scope: 'BYTE_BOUND_SAME_SHA_OBSERVER_ONLY_COMPARISON',
    receiptBytesVerified: true,
    r0,
    r1,
    compilerOnlyAttribution: false,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ownedBoundaries = process.argv[5] === '--owned-boundaries';
  if ((process.argv.length !== 5 && !(process.argv.length === 6 && ownedBoundaries)) || existsSync(process.argv[4]))
    throw Error('FRESH_OBSERVER_OUTPUT_REQUIRED');
  const r =
    process.argv[2] === '--prepare'
      ? observerTargetInputs(process.argv[3], { ownedBoundaries })
      : analyzeObserverPair(process.argv[2], process.argv[3], { ownedBoundaries });
  writeFileSync(process.argv[4], JSON.stringify(r, null, 2) + '\n');
}
