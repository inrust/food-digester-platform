/** Merge immutable historical evidence without changing its original verdict. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bindFile,
  readBoundFile,
  sha256,
  contentSnapshot,
  CONTEXT_EXECUTOR_FILES,
  CONTEXT_DOCUMENT_FILES,
} from './qa09-acceptance-context.mjs';
import { buildFrozenScope, FORMAL_DOMAINS } from './qa09-acceptance-scope.mjs';
import { compareApplicationInputs } from './collect-qa09-business-reconciliation.mjs';
import { assertScopedSignedSession } from './qa09-business-reconciliation.mjs';
import { validateUserBrowserEvidence } from './qa09-user-closeout-browser.mjs';

export const A1_DOCUMENTS = CONTEXT_DOCUMENT_FILES;
export const HISTORICAL_SEALS = [
  {
    directory: 'qa-09-close-01-2026-10-12',
    sealCommit: 'dade6d950eb5fc681f9ab8c876762de5ffc77f4f',
    receipt: 'user-target-v2.json',
    sources: 'user-target-v2.json.sources.json',
    version: 'application-version.json',
    config: 'api-entry-config.json',
    cleanup: 'final-readonly-recovered.json',
  },
  {
    directory: 'qa-09-close-07-2026-10-13',
    sealCommit: 'ee8f0713cdc5785dbf45e354f1f63723d77e3716',
    receipt: 'target-v2.json.reliability.json',
    parent: 'target-v2.json',
    sources: 'target-v2.json.sources.json',
    version: 'application-version.json',
    config: 'api-final-config.json',
    cleanup: 'final-readonly.json',
  },
  {
    directory: 'qa-09-close-07-esg-2026-10-13',
    sealCommit: 'f8e943d2c1a3bca6418f238e732a275e255fc75c',
    receipt: 'target-v3.json.reliability.json',
    parent: 'target-v3.json',
    sources: 'target-v3.json.sources.json',
    version: 'application-version-v3.json',
    config: 'api-final-config.json',
    cleanup: 'final-readonly.json',
  },
];
export function verifyHistoricalSeal(root, item) {
  const dir = 'docs/audit/evidence/' + item.directory;
  const manifestRef = bindFile(root, dir + '/manifest.json');
  const manifest = JSON.parse(readBoundFile(root, manifestRef));
  const files = Object.entries(manifest.files).map(([name, digest]) => ({ path: dir + '/' + name, sha256: digest }));
  files.forEach((ref) => readBoundFile(root, ref));
  // Tool and documentation edits intentionally differ now; check original committed bytes.
  for (const [path, digest] of Object.entries(manifest.bindings)) {
    const bytes = execFileSync('git', ['show', item.sealCommit + ':' + path], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (sha256(bytes) !== digest) throw Error('HISTORICAL_SEAL_BINDING_DRIFT:' + path);
  }
  const read = (name) => JSON.parse(readFileSync(resolve(root, dir, name)));
  const source = read(item.sources);
  if (!source.sources?.length || new Set(source.sources.map((row) => row.path)).size !== source.sources.length)
    throw Error('EXECUTED_SOURCE_SET_MISSING');
  for (const row of source.sources)
    if (sha256(Buffer.from(row.sourceBase64, 'base64')) !== row.sha256) throw Error('HISTORICAL_EXECUTOR_BYTES_DRIFT');
  const receipt = read(item.receipt),
    version = read(item.version),
    cleanup = read(item.cleanup),
    config = read(item.config);
  if (
    receipt.sourceCommit !== version.sourceCommit ||
    receipt.fullQa09Accepted !== false ||
    version.gate !== 'PASS' ||
    !receipt.finishedAt
  )
    throw Error('HISTORICAL_RECEIPT_VERSION_DRIFT');
  if (item.parent) {
    const parent = read(item.parent);
    if (
      receipt.prefix !== parent.prefix ||
      parent.gate !== 'PASS' ||
      receipt.businessCleanup !== 'PASS' ||
      cleanup.prefix !== parent.prefix ||
      cleanup.sourceCommit !== parent.sourceCommit ||
      cleanup.parentSha256 !== sha256(readFileSync(resolve(root, dir, item.parent))) ||
      cleanup.gate !== 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL'
    )
      throw Error('HISTORICAL_OWNERSHIP_CLEANUP_DRIFT');
  } else {
    assertScopedSignedSession(receipt);
    if (!receipt.userBrowser?.length) throw Error('HISTORICAL_BROWSER_PROOF_MISSING');
    receipt.userBrowser.forEach(validateUserBrowserEvidence);
  }
  return {
    receipt,
    version,
    cleanup,
    config,
    proof: {
      manifest: manifestRef,
      originalSealCommit: item.sealCommit,
      originalReceipt: bindFile(root, dir + '/' + item.receipt),
      originalExecutor: bindFile(root, dir + '/' + item.sources),
      originalVersion: bindFile(root, dir + '/' + item.version),
      originalConfig: bindFile(root, dir + '/' + item.config),
      originalCleanup: bindFile(root, dir + '/' + item.cleanup),
      verifiedFiles: files.length,
      originalGate: receipt.gate,
      sourceCommit: receipt.sourceCommit,
      prefix: receipt.prefix,
      fullQa09Accepted: false,
    },
  };
}
export function mergeHistoricalEvidence(root, targetApplication) {
  const verified = HISTORICAL_SEALS.map((item) => verifyHistoricalSeal(root, item));
  const targetConfig = verified[2].config;
  const configKeys = [
    'memory',
    'pool',
    'engineCpu',
    'preconnect',
    'accountReadCandidate',
    'contractLoadDetail',
    'contractPublicBoundaries',
    'contractObserverCost',
  ];
  const evidence = verified.map(({ proof, config }) => {
    const comparison = compareApplicationInputs(proof.sourceCommit, targetApplication);
    const sourceEquivalent = comparison.every((row) => row.equal);
    const originalConfig = config.config ?? config;
    const configurationComparison = configKeys.map((key) => ({
      key,
      original: originalConfig[key],
      target: targetConfig.config[key],
      equal: originalConfig[key] === targetConfig.config[key],
    }));
    const configEquivalent =
      configurationComparison.every((row) => row.equal) &&
      config.concurrency?.ReservedConcurrentExecutions === targetConfig.concurrency?.ReservedConcurrentExecutions;
    return {
      ...proof,
      applicationComparison: comparison,
      sourceEquivalent,
      configEquivalent,
      configurationComparison,
      compatibility:
        sourceEquivalent && configEquivalent
          ? 'SCOPED_REUSE_CANDIDATE_ORIGINAL_RUN_CONFIG_MATCHES'
          : 'REVALIDATE_CHANGED_INPUTS_OR_CONFIG',
      currentLiveEnvironmentVerified: false,
      formalReceiptPassClaimed: false,
    };
  });
  const replay = verified[1].receipt,
    esg = verified[2].receipt;
  if (
    replay.replayGate !== 'PASS_NONEMPTY_EXACT_SCOPE_REPLAY' ||
    replay.replayConsumption?.gate !== 'PASS_EXACT_DUPLICATE_CONSUMPTION' ||
    replay.dedupGate !== 'NO_RECEIPT' ||
    replay.replayProducerToSpecificSqsIdClaimed !== false ||
    esg.gate !== 'PASS_SCOPED_ESG_LEASE_AND_CONSISTENCY' ||
    esg.jobs?.length !== 4 ||
    esg.jobs.some((job) => job.csv?.gate !== 'PASS_NONEMPTY_CSV_DATABASE_EQUAL' || job.csv.rowCount < 1) ||
    esg.finalConsistency?.gate !== 'PASS_REAL_MQTT_DAILY_ARCHIVE_ESG_CONSISTENCY' ||
    esg.leaseRecovery?.gate !== 'PASS_OWN_EXPIRED_EXPORT_LEASE_RECOVERY'
  )
    throw Error('SCOPED_HISTORY_CONTRACT_DRIFT');
  const reconciliationRef = bindFile(root, 'docs/audit/evidence/qa-09-close-01-2026-10-12/reconciliation-after.json');
  const reconciliation = JSON.parse(readBoundFile(root, reconciliationRef));
  reconciliation.refs.forEach((ref) => readBoundFile(root, ref));
  const operationRoleLedger = reconciliation.pairs.map((pair) => ({
    operationId: pair.operationId,
    role: pair.role,
    method: pair.method,
    path: pair.path,
    historicalHttpSuccess: pair.historicalHttpSuccess,
    originalEvidence: pair.evidence,
    currentAcceptance: 'DOMAIN_PERSISTENCE_AND_COMPATIBILITY_REVIEW_REQUIRED_NOT_HTTP_PASS',
  }));
  const prototypeLedger = reconciliation.semantic.elements.map((element) => ({
    ...element,
    historicalSupplement: reconciliation.semanticSupplement.filter((item) => item.id === element.id),
    currentAcceptance: 'ORIGINAL_SCOPE_AND_COMPATIBILITY_REVIEW_REQUIRED',
  }));
  return {
    evidence,
    operationRoleLedger,
    prototypeLedger,
    originalCandidateGaps: reconciliation.originalMissingCandidates,
    deduplicatedNeverRunGaps: reconciliation.originalMissingCandidates.filter(
      (item) => item.historicalNeverRunClaimStillValid && !item.domainSuccessNotApplicable,
    ),
    scopedProofs: [
      {
        id: 'users.signedSessionAndState',
        source: evidence[0].originalReceipt,
        result: verified[0].receipt.gate,
        limitation: 'Signed-user/roles/scope/disable only; notifications and all signed claims not covered',
      },
      {
        id: 'replay.superAdminNonemptyAndDuplicateConsumption',
        source: evidence[1].originalReceipt,
        result: replay.replayGate,
        limitation: 'Operator, producer association and same-run nonempty daily dedup remain open',
      },
      {
        id: 'data.naturalEsgConsistency',
        source: evidence[2].originalReceipt,
        result: esg.finalConsistency.gate,
        limitation: 'Simulated device; no schedule invocation association, cross-run dedup or third-party verification',
      },
      {
        id: 'data.exportLeaseRecovery',
        source: evidence[2].originalReceipt,
        result: esg.leaseRecovery.gate,
        limitation: 'One own job and four nonempty datasets by SuperAdmin; other role paths remain open',
      },
    ],
    historicalCoverage: {
      source: reconciliationRef,
      httpPairs: reconciliation.historicallyObservedPairs,
      candidatePairs: reconciliation.candidatePairs,
      semantic: reconciliation.combinedHistoricalBehaviorCoverage,
      currentAcceptanceClaimed: false,
    },
    originalFailuresAndUnknownsPreserved: true,
    fullQa09Accepted: false,
  };
}
export async function collectAcceptanceInventory(root, outputDirectory) {
  const path = (name) => outputDirectory + '/' + name;
  for (const name of ['scope.json', 'inventory.json', 'bindings.json'])
    if (existsSync(resolve(root, path(name)))) throw Error('FRESH_A1_OUTPUT_REQUIRED');
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const application = 'ee8f0713cdc5785dbf45e354f1f63723d77e3716';
  const scope = await buildFrozenScope(root);
  const history = mergeHistoricalEvidence(root, application);
  const inventory = {
    schemaVersion: '1.0',
    task: 'QA09-A1',
    applicationSourceCommit: application,
    ...history,
    formalDomains: FORMAL_DOMAINS.map((domain) => ({
      id: domain.id,
      validator: domain.validator,
      receipt: domain.receipt,
      status: existsSync(resolve(root, domain.receipt)) ? 'REQUIRES_ORIGINAL_VALIDATOR' : 'NO_FORMAL_RECEIPT',
      fullOriginalContractRequired: true,
    })),
    mandatory: scope.mandatorySupplemental.map((item) => ({
      ...item,
      evidenceCandidates: history.scopedProofs.filter((proof) => proof.id === item.id),
      status: item.initialStatus,
    })),
    releaseDeferrals: scope.releaseDeferrals,
    qa09BusinessGate: 'PARTIAL',
    releasePerformanceAccepted: false,
    productionReady: false,
    cloudRequests: 0,
    originalReceiptsModified: false,
    acceptancePromotion: false,
  };
  const write = (name, data) => writeFileSync(resolve(root, path(name)), JSON.stringify(data, null, 2) + '\n');
  write('scope.json', scope);
  write('inventory.json', inventory);
  const dir = 'docs/audit/evidence/qa-09-close-07-esg-2026-10-13/';
  const bindings = {
    schemaVersion: '2.0',
    task: 'QA09-A1',
    scope: 'QA09_BUSINESS_ACCEPTANCE_ENTRY',
    environment: {
      mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
      isolated: false,
      accountId: '065986019555',
      region: 'ap-southeast-1',
      stackName: 'fdp-test-app',
      syntheticResponsesAllowed: false,
      dataSeparation: 'UNIQUE_RUN_PREFIX_AND_CREATED_ID_LEDGER',
    },
    versions: {
      application: {
        sourceCommit: application,
        deploymentCommit: application,
        versionReceipt: bindFile(root, dir + 'application-version-v3.json'),
        configurationReceipt: bindFile(root, dir + 'api-final-config.json'),
        freshness: 'RECORDED_TARGET_SNAPSHOT_NOT_A_NEW_LIVE_READ',
      },
      executor: contentSnapshot(root, baseCommit, CONTEXT_EXECUTOR_FILES),
      documentation: contentSnapshot(root, baseCommit, A1_DOCUMENTS),
    },
    requiredDocumentation: A1_DOCUMENTS,
    frozenScope: bindFile(root, path('scope.json')),
    inventory: bindFile(root, path('inventory.json')),
    formalReceipts: [],
    fullQa09Accepted: false,
    releasePerformanceAccepted: false,
    productionReady: false,
  };
  write('bindings.json', bindings);
  return {
    gate: 'PASS_A1_INVENTORY_GENERATED',
    application,
    mergedRuns: history.evidence.length,
    scopedProofs: history.scopedProofs.length,
    mandatorySupplemental: inventory.mandatory.length,
    formalDomains: inventory.formalDomains.length,
    releaseDeferrals: inventory.releaseDeferrals.length,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw Error('OUTPUT_DIRECTORY_REQUIRED');
  console.log(JSON.stringify(await collectAcceptanceInventory(process.cwd(), output)));
}
