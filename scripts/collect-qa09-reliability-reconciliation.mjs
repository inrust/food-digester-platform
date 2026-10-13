import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareApplicationInputs } from './collect-qa09-business-reconciliation.mjs';
import { sha256 } from './qa09-reliability-closeout.mjs';
export function collectReliabilityReconciliation(output, targetCommit, freshPath) {
  if (existsSync(output)) throw Error('FRESH_RELIABILITY_INVENTORY_REQUIRED');
  const refs = [],
    comparisons = {};
  const bind = (path) => {
    const bytes = readFileSync(path);
    refs.push({ path, sha256: sha256(bytes) });
    return JSON.parse(bytes);
  };
  const old = 'docs/audit/evidence/qa-09-remaining-writes-security-recovery-2026-10-05/';
  const continuation = 'docs/audit/evidence/qa-09-continuation-2026-10-04/';
  const writes = bind(old + 'writes-retest.json');
  const redelivery = bind(old + 'redelivery-final.json.gate.json');
  bind(old + 'redelivery-final.json.submission.json');
  bind(old + 'redelivery-final.json.data-path.json');
  const correction = bind(continuation + 'normal-queue-claim-correction.json');
  for (const ref of correction.inputs) {
    const bytes = readFileSync(ref.path);
    if (sha256(bytes) !== ref.sha256) throw Error('HISTORICAL_CORRECTION_BINDING_DRIFT');
    refs.push(ref);
  }
  const wave = bind(continuation + 'real-wave.json.business.json');
  const lease = bind(continuation + 'real-wave.json.business.json.business-inject-export-lease-4.json');
  const cleanup = bind(continuation + 'recovered-closure-8.json');
  bind(continuation + 'recovered-closure-8.json.audit-empty.json');
  const normalCleanup = bind(continuation + 'normal-recovered-closure.json');
  const exports = bind(old + 'redelivery.json.super-exports.json');
  for (const b of exports.databaseBuilds) bind(b.receipt);
  for (const receipt of [writes, wave])
    for (const source of receipt.sources ?? [])
      if (
        sha256(Buffer.from(source.sourceBase64, 'base64')) !== source.sha256 ||
        receipt.sourceHashes[source.path] !== source.sha256
      )
        throw Error('HISTORICAL_EXECUTED_SOURCE_DRIFT');
  if (
    writes.remaining?.replayJobs?.length !== 2 ||
    writes.remaining.replayJobs.some((j) => j.resultSummary.sent !== 0 || j.provesMessageReplay !== false) ||
    redelivery.queueSubmissionGate !== 'BLOCKED' ||
    correction.queueSpecificConsumptionProven !== false ||
    correction.originalReceiptPreserved !== true ||
    lease.gate !== 'PASS' ||
    lease.result?.action !== 'business-inject-export-lease' ||
    !['own-export-lease-expired', 'expired-processing-lease-recovered', 'esg-export-csv-count'].every((id) =>
      wave.checks.some((c) => c.id === id && c.result === 'PASS'),
    ) ||
    cleanup.gate !== 'PASS' ||
    wave.gate !== 'FAIL' ||
    exports.gate !== 'PASS'
  )
    throw Error('HISTORICAL_RELIABILITY_CLAIM_NOT_BOUND');
  for (const commit of new Set([writes.sourceCommit, redelivery.sourceCommit, wave.sourceCommit]))
    comparisons[commit] = compareApplicationInputs(commit, targetCommit);
  const targetVersion = bind(output.replace(/[^/]+$/, '') + 'application-version.json');
  if (
    targetVersion.gate !== 'PASS' ||
    targetVersion.sourceCommit !== targetCommit ||
    targetVersion.lambdaArtifacts?.length !== 19
  )
    throw Error('CURRENT_RELIABILITY_VERSION_REQUIRED');
  const artifactComparisons = [];
  for (const file of [continuation + 'application-version.json', old + 'application-version.json']) {
    const historicalVersion = bind(file);
    for (const name of ['fdp-test-replay', 'fdp-test-esg-export', 'fdp-test-archive', 'fdp-test-ingestion']) {
      const previous = historicalVersion.lambdaArtifacts?.find((a) => a.name === name);
      const current = targetVersion.lambdaArtifacts.find((a) => a.name === name);
      if (!previous || !current || !previous.matches || !current.matches)
        throw Error('RELIABILITY_ARTIFACT_BINDING_REQUIRED');
      artifactComparisons.push({
        name,
        sourceCommit: historicalVersion.sourceCommit,
        previousCodeSha256: previous.codeSha256,
        currentCodeSha256: current.codeSha256,
        identicalCode: previous.codeSha256 === current.codeSha256,
        historicalRuntimeConfigurationNotCurrentAcceptance: true,
      });
    }
  }
  const historical = [
    {
      id: 'NONEMPTY_REPLAY',
      evidence: old + 'writes-retest.json',
      sourceCommit: writes.sourceCommit,
      gate: 'NOT_RUN_EMPTY_SOURCE_ONLY',
      roles:
        writes.remaining?.replayJobs?.map((j) => ({ role: j.role, sent: j.resultSummary.sent })) ??
        writes.performance?.replayJobs ??
        [],
      meaning: 'Terminal empty-source Jobs prove role/scope plumbing only, never message replay',
    },
    {
      id: 'QUEUE_REDELIVERY_CONSUMPTION',
      evidence: old + 'redelivery-final.json.gate.json',
      sourceCommit: redelivery.sourceCommit,
      gate: redelivery.gate,
      submission: redelivery.queueSubmissionGate,
      consumption: redelivery.queueConsumptionGate,
      cleanup: redelivery.cleanup,
    },
    {
      id: 'ORIGINAL_QUEUE_LABEL_CORRECTION',
      evidence: continuation + 'normal-queue-claim-correction.json',
      sourceCommit: wave.sourceCommit,
      gate: correction.gate,
      correctedClaim: correction.queueRedeliveryIdempotencyObserved,
      originalPreserved: correction.originalReceiptPreserved,
    },
    {
      id: 'EXPORT_EXPIRED_LEASE_AND_ARCHIVE',
      evidence: continuation + 'real-wave.json.business.json',
      sourceCommit: wave.sourceCommit,
      originalExecutionGate: wave.gate,
      gate: 'HISTORICAL_SCOPED_PROOF_REVALIDATE_CHANGED_INPUTS',
      cleanup: cleanup.gate,
      meaning:
        'Expired own export lease recovery and downloaded CSV; raw archive hashes belong to original source/config, not current version',
    },
    {
      id: 'NONEMPTY_ESG_EXPORT',
      evidence: old + 'redelivery.json.super-exports.json',
      sourceCommit: redelivery.sourceCommit,
      gate: exports.gate,
      jobs: exports.jobs.map((j) => ({ kind: j.kind, rowCount: j.csv.rowCount, sha256: j.csv.sha256 })),
      meaning: 'Own nonempty ESG CSV; empty activity CSV is not nonempty activity acceptance',
    },
    {
      id: 'ORIGINAL_FAILURE_AND_RECOVERED_CLEANUP',
      evidence: continuation + 'recovered-closure-8.json',
      sourceCommit: wave.sourceCommit,
      originalExecutionGate: wave.gate,
      gate: cleanup.gate,
      normalCleanup: normalCleanup.gate,
    },
  ];
  let current;
  if (freshPath) {
    const r = bind(freshPath),
      parent = bind(freshPath.replace(/\.reliability\.json$/, ''));
    current = {
      evidence: freshPath,
      sourceCommit: r.sourceCommit,
      gate: r.gate,
      replayGate: r.replayGate,
      queueConsumptionGate: r.queueConsumptionGate,
      dedupGate: r.dedupGate,
      replayConsumptionGate: r.replayConsumption?.gate,
      replayProducerToSpecificSqsIdClaimed: r.replayProducerToSpecificSqsIdClaimed,
      replayAuditGate: r.replayAuditGate,
      businessCleanup: r.businessCleanup,
      parentGate: parent.gate,
      parentCleanup: parent.cleanup,
      fullQa09Accepted: false,
    };
    if (r.sourceCommit !== targetCommit) throw Error('FRESH_RELIABILITY_VERSION_DRIFT');
  }
  const r = {
    task: 'QA09-CLOSE-07',
    targetCommit,
    gate:
      current?.gate === 'PASS_SCOPED_RELIABILITY' && current.businessCleanup === 'PASS' && current.parentGate === 'PASS'
        ? 'PASS_NEW_REPLAY_REDELIVERY_SCOPE_QA09_PARTIAL'
        : 'PASS_INVENTORY_QA09_PARTIAL',
    historical,
    comparisons,
    artifactComparisons,
    refs,
    current,
    compatibilityRule:
      'Identical source trees support reuse only within original configuration and scope; changed application/infra/dependency trees require current receipts. Historical FAIL and corrected false claims stay unchanged.',
    deferred: [
      'REL-PERF-01: deep performance and transport tails',
      'CLOSE-08: formal target Gate mapping',
      'Active lifecycle requires independent device verification',
      'Current-version export lease and full archive/ESG consistency remain separate receipts',
    ],
    unknownStartPolicy:
      'Never repeat StartBuild for an original UNKNOWN Plan. Only bounded exact read recovery may bind an existing Build. Original failure remains.',
    fullQa09Accepted: false,
  };
  writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, commit, fresh] = process.argv.slice(2);
  collectReliabilityReconciliation(output, commit, fresh);
}
