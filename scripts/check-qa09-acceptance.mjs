/** A1 provenance/scope entry. Domain PASS never substitutes for outstanding specialized business probes. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateTargetBindings, readBoundFile } from './qa09-acceptance-context.mjs';
import { FORMAL_DOMAINS, buildFrozenScope } from './qa09-acceptance-scope.mjs';
import { mergeHistoricalEvidence } from './collect-qa09-acceptance-inventory.mjs';

export async function checkAcceptanceEntry(root, context) {
  validateTargetBindings(root, context);
  const scope = JSON.parse(readBoundFile(root, context.frozenScope));
  if (!isDeepStrictEqual(scope, await buildFrozenScope(root))) throw Error('FROZEN_REQUIRED_SCOPE_DRIFT');
  const inventory = JSON.parse(readBoundFile(root, context.inventory));
  const history = mergeHistoricalEvidence(root, context.versions.application.sourceCommit);
  for (const key of [
    'evidence',
    'scopedProofs',
    'historicalCoverage',
    'operationRoleLedger',
    'prototypeLedger',
    'originalCandidateGaps',
    'deduplicatedNeverRunGaps',
  ])
    if (!isDeepStrictEqual(inventory[key], history[key])) throw Error('HISTORICAL_EVIDENCE_MERGE_DRIFT');
  if (
    inventory.applicationSourceCommit !== context.versions.application.sourceCommit ||
    inventory.fullQa09Accepted !== false ||
    inventory.qa09BusinessGate !== 'PARTIAL' ||
    inventory.acceptancePromotion !== false ||
    !isDeepStrictEqual(
      inventory.mandatory,
      scope.mandatorySupplemental.map((item) => ({
        ...item,
        evidenceCandidates: history.scopedProofs.filter((proof) => proof.id === item.id),
        status: item.initialStatus,
      })),
    ) ||
    !isDeepStrictEqual(inventory.releaseDeferrals, scope.releaseDeferrals)
  )
    throw Error('UNSUPPORTED_ACCEPTANCE_PROMOTION_OR_SCOPE_DRIFT');
  const expectedDomains = FORMAL_DOMAINS.map((domain) => ({
    id: domain.id,
    validator: domain.validator,
    receipt: domain.receipt,
    status: existsSync(resolve(root, domain.receipt)) ? 'REQUIRES_ORIGINAL_VALIDATOR' : 'NO_FORMAL_RECEIPT',
    fullOriginalContractRequired: true,
  }));
  if (!isDeepStrictEqual(inventory.formalDomains, expectedDomains)) throw Error('FORMAL_DOMAIN_INVENTORY_DRIFT');
  if (context.formalReceipts.some((row) => !FORMAL_DOMAINS.some((domain) => domain.validator === row.validator)))
    throw Error('UNKNOWN_FORMAL_VALIDATOR');
  const domains = [];
  for (const domain of FORMAL_DOMAINS) {
    const module = await import(pathToFileURL(resolve(root, 'scripts', domain.validator)));
    const bound = context.formalReceipts.find((row) => row.validator === domain.validator);
    const errors = bound
      ? module[domain.check](root, bound.receipt.path, context.versions.application.sourceCommit, context)
      : ['NO_BOUND_FORMAL_RECEIPT:' + domain.receipt];
    if (bound && errors.length) throw Error('BOUND_FORMAL_RECEIPT_FAILED:' + errors.join(';'));
    domains.push({ id: domain.id, validator: domain.validator, gate: errors.length ? 'PARTIAL' : 'PASS', errors });
  }
  return {
    task: 'QA09-A1',
    gate: 'PASS_A1_ENTRY_AND_FROZEN_INVENTORY',
    versions: context.versions,
    environment: context.environment,
    formalDomains: domains,
    formalPassCount: domains.filter((row) => row.gate === 'PASS').length,
    formalRequiredCount: 8,
    mandatorySupplemental: inventory.mandatory,
    releaseDeferrals: inventory.releaseDeferrals,
    qa09BusinessGate: 'PARTIAL',
    fullQa09Accepted: false,
    releasePerformanceAccepted: false,
    productionReady: false,
    closureBoundary:
      'A1 verifies entry and frozen evidence inventory. A8 must validate remaining specialized business probes; free-form PASS flags are rejected.',
    cloudRequests: 0,
    historicalResultsPromoted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--minimum') {
      const args = process.argv.slice(3);
      if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith('--')))
        throw Error('UNKNOWN_MINIMUM_ARGUMENT');
      const { runMinimumPhaseCheck } = await import('./check-qa09-minimum-phase.mjs');
      await runMinimumPhaseCheck(...args);
    } else {
      const args = process.argv.slice(2).filter((arg) => arg !== '--entry-only');
      if (args.length > 2 || args.some((arg) => arg.startsWith('--'))) throw Error('UNKNOWN_ACCEPTANCE_ARGUMENT');
      const [input, output] = args;
      if (!input || (output && existsSync(output))) throw Error('INPUT_AND_FRESH_OUTPUT_REQUIRED');
      const result = await checkAcceptanceEntry(process.cwd(), JSON.parse(readFileSync(input)));
      if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
      console.log(
        JSON.stringify({
          gate: result.gate,
          formalPassCount: result.formalPassCount,
          qa09BusinessGate: result.qa09BusinessGate,
          fullQa09Accepted: false,
        }),
      );
      // Business mode fails closed; --entry-only is explicitly limited to A1 infrastructure validation.
      process.exitCode = process.argv.includes('--entry-only') ? 0 : 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
