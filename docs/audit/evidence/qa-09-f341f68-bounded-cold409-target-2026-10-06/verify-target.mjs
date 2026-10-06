import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  validateBusinessVersion,
  validateBusinessDatabaseReceipts,
} from '../../../../scripts/check-qa09-business-target.mjs';
import { validateContractRecovery } from '../../../../scripts/recover-qa09-contract-race.mjs';
import { bindAudits, overlap } from '../../../../scripts/check-qa09-contract-race.mjs';
import { validatePhaseCorrelation } from '../../../../scripts/check-qa09-contract-phases.mjs';
import { validateSamplingCorrelationLedger } from '../../../../scripts/qa09-cold409-proof.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const bindings = {};
const digest = (b) => createHash('sha256').update(b).digest('hex');
const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
const read = (name) => {
  const b = readFileSync(join(dir, name));
  bindings[name] = digest(b);
  return JSON.parse(b);
};
const child = read('sample.json'),
  parent = read('sample.json.fixtures.json');
demand(
  child.gate === 'PASS' &&
    child.cleanupComplete === true &&
    child.checks.every((c) => c.result === 'PASS') &&
    parent.globalSignOut === 'PASS' &&
    parent.gate === 'PASS' &&
    parent.finishedAt,
  'FINAL_RESULTS_INCOMPLETE',
);
const race = validateContractRecovery(child, parent);
const version = read('application-version.json'),
  final = read('runtime-final.json');
validateBusinessVersion(version, child.sourceCommit);
demand(
  final.sourceCommit === child.sourceCommit && final.lambdaArtifacts.length === 19 && final.blockers.length === 0,
  'FINAL_VERSION_INCOMPLETE',
);
for (const a of version.lambdaArtifacts)
  demand(
    final.lambdaArtifacts.some(
      (b) =>
        b.name === a.name &&
        ['codeSha256', 'revisionId', 'runtime', 'state', 'lastUpdateStatus'].every((k) => a[k] === b[k]),
    ),
    'RUNTIME_DRIFT',
  );
const runtimeBinding = {
  gate: 'PASS',
  sourceCommit: child.sourceCommit,
  initialVersionSha256: bindings['application-version.json'],
  runtimeFinalSha256: bindings['runtime-final.json'],
  lambdaCount: 19,
  scope: 'FINAL_METADATA_PAIRED_WITH_INITIAL_ZIP_BYTES',
  rawRuntimeGate: final.gate,
};
writeFileSync(join(dir, 'runtime-final-binding.json'), JSON.stringify(runtimeBinding, null, 2) + '\n');
read('runtime-final-binding.json');
const patch = read('baseline-patch.json'),
  audit = read('baseline-audit.json');
for (const [r, n] of [
  [patch, 6],
  [audit, 19],
])
  demand(
    r.gate === 'PASS' &&
      r.exactLinkedCount === n &&
      r.records.length === n &&
      Object.keys(r.logReadErrors).length === 0 &&
      r.sourceReceiptSha256 === bindings['sample.json'],
    'CORRELATION_BINDING',
  );
const phase = validatePhaseCorrelation(patch, audit, { accountPhases: true, requireColdConflict: false });
demand(
  phase.summaries.length === 25 &&
    read('baseline-phases.json').gate === 'PASS' &&
    read('baseline-phases.json').accountPhasesRequired === true &&
    read('baseline-phases.json').coldConflictRequired === false,
  'PHASE_PROOF',
);
for (const a of race.attempts)
  demand(
    patch.records.filter(
      (r) =>
        r.requestId === a.clientRequestId &&
        r.status === a.observation.status &&
        r.exactLinked &&
        !r.integrationThrottled,
    ).length === 1,
    'PATCH_LINK',
  );
bindAudits(
  race.attempts,
  race.audit.filter((a) => a.result === 'SUCCESS').map((a) => ({ ...a, auditId: a.id })),
);
for (const a of race.attempts.filter((a) => a.observation.status === 409))
  demand(
    race.audit.filter(
      (b) => b.requestId === a.clientRequestId && b.result === 'FAILURE' && b.beforeVersion === a.ifMatch,
    ).length === 1,
    'FAILURE_AUDIT',
  );
for (const round of race.rounds)
  demand(
    round.beforeVersion === round.round &&
      round.readback.name === race.attempts.find((a) => a.round === round.round && a.observation.status === 200).name,
    'WINNER_READBACK',
  );
validateBusinessDatabaseReceipts(
  child,
  child.databaseBuilds.map((b) => read(b.receipt.split('/').at(-1))),
);
const sources = read('sample.json.sources.json');
const hashes = new Map(
  sources.sources.map((s) => {
    demand(digest(Buffer.from(s.sourceBase64, 'base64')) === s.sha256, 'SOURCE_BYTES');
    demand(digest(execFileSync('git', ['show', child.sourceCommit + ':' + s.path])) === s.sha256, 'EXECUTED_SHA_SOURCE_DRIFT');
    return [s.path, s.sha256];
  }),
);
for (const s of child.sources) demand(hashes.get(s.path) === s.sha256, 'EXECUTED_SOURCE_DRIFT');
const builds = parent.databaseBuilds.map((b) => {
  const r = read(b.receipt.split('/').at(-1));
  demand(
    r.gate === 'PASS' &&
      r.build.status === 'SUCCEEDED' &&
      r.build.id === b.buildId &&
      r.build.serviceRole === 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' &&
      r.result.prefix === child.prefix &&
      r.result.action === b.action &&
      r.result.sourceHash === hashes.get('scripts/qa09-ten-device-db.mjs'),
    'PARENT_BUILD_BINDING',
  );
  return r;
});
const initial = builds.find((b) => b.result.action === 'observe').result;
const cleaned = builds.find((b) => b.result.action === 'cleanup').result;
demand(
  JSON.stringify(initial.originalFingerprints) === JSON.stringify(cleaned.originalFingerprints),
  'OUTSIDE_DEVICE_CERT_DRIFT',
);
demand(cleaned.deleted.devices === 10, 'EXACT_DELETE_COUNT');
for (const k of [
  'certificates',
  'rotationRequests',
  'requests',
  'jobs',
  'receipts',
  'latest',
  'outbox',
  'telemetrySamples',
])
  demand(Array.isArray(cleaned[k]) && cleaned[k].length === 0, 'OWN_DATABASE_RESIDUE');
for (const c of [...child.cleanup, ...parent.cleanup]) demand(c.result === 'PASS', 'CLEANUP_FAILED');
for (const s of child.createdSites)
  demand(
    child.cleanup.some((c) => c.type === 'site' && c.id === s.id),
    'SITE_CLEANUP',
  );
for (const c of parent.customers)
  demand(
    parent.cleanup.some((x) => x.type === 'customer' && x.id === c.id),
    'CUSTOMER_CLEANUP',
  );
for (const i of child.createdIdentities)
  demand(
    child.cleanup.some((c) => c.type === 'cognito' && c.username === i.username && c.globalSignOut === 'PASS'),
    'CHILD_IDENTITY_CLEANUP',
  );
demand(
  parent.cleanup.some((c) => c.type === 'identity' && c.username === parent.identity.username),
  'ROOT_IDENTITY_CLEANUP',
);
const domain = read('sample.json.domain-cleanup.json'),
  wrapper = read('sample.json.gate.json');
demand(
  domain.gate === 'PASS' &&
    domain.observations.length === 2 &&
    domain.observations.every((o) => o.versionsRemaining === 0 && domain.prefixes.includes(o.prefix)) &&
    domain.parentReceiptSha256 === bindings['sample.json.fixtures.json'] &&
    wrapper.gate === 'PASS' &&
    wrapper.cleanup === 'PASS' &&
    wrapper.sourceReceiptSha256 === bindings['sample.json.sources.json'],
  'FINAL_CLEANUP_GATE',
);
const empty = read('database-empty-audit.json');
demand(
  empty.gate === 'PASS' &&
    empty.build.status === 'SUCCEEDED' &&
    empty.build.id === empty.result.buildId &&
    empty.build.serviceRole === 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' &&
    empty.result.action === 'audit-empty' &&
    empty.result.prefix === child.prefix &&
    empty.result.sourceHash === hashes.get('scripts/qa09-ten-device-db.mjs') &&
    empty.result.empty === true &&
    ['devices', 'certificates', 'onboardingRequests'].every((k) => empty.result[k].length === 0) &&
    JSON.stringify(empty.result.originalFingerprints) === JSON.stringify(initial.originalFingerprints),
  'POST_CLEANUP_EMPTY_PROOF',
);
const samplePatch = read('sampling-patch.json'), sampleAudit = read('sampling-audit.json');
const sample = validateSamplingCorrelationLedger(child, samplePatch, sampleAudit);
for (const [r, n] of [[samplePatch,12],[sampleAudit,18]]) demand(r.exactLinkedCount===n && r.records.length===n && r.sourceReceiptSha256===bindings['sample.json'] && Object.keys(r.logReadErrors).length===0, 'SAMPLE_LOG_BINDING');
const samplingPhase = validatePhaseCorrelation(samplePatch, sampleAudit, {accountPhases:true, sampling:true});
const observed = read('sampling-phases.json');
demand(observed.gate==='PASS' && observed.summaries.length===30 && observed.coldConflictRequired===false && observed.platformColdProofRequired===true, 'SAMPLING_PHASE_PROOF');
const strictExit = Number(readFileSync(join(dir,'cold-phases.exit'),'utf8').trim());
const coldAccepted = samplingPhase.coldConflictObservedCount>0;
if(coldAccepted) { const strict = read('cold-phases.json'); demand(strictExit===0 && strict.gate==='PASS' && strict.coldConflictRequired===true && strict.coldConflictObservedCount===samplingPhase.coldConflictObservedCount, 'STRICT_COLD_PROOF'); }
else { demand(strictExit!==0 && readFileSync(join(dir,'cold-phases.stderr.log'),'utf8').includes('COLD_CONFLICT_REQUIRED'), 'STRICT_COLD_FAILURE_REQUIRED'); }
const pairs=sample.contracts.map(c=>{const pair=samplePatch.records.filter(r=>sample.attempts.some(a=>a.contractId===c.contractId && a.clientRequestId===r.requestId));demand(pair.length===2,'SAMPLE_PAIR');const gw=pair.map(r=>[Number(r.gateway[0].requestTimeEpoch),Number(r.gateway[0].requestTimeEpoch)+Number(r.gateway[0].responseLatency)]);const lm=pair.map(r=>[r.lambda[0].logTimestampMs-r.lambda[0].elapsedMs,r.lambda[0].logTimestampMs]);const ms=w=>Math.max(0,Math.min(w[0][1],w[1][1])-Math.max(w[0][0],w[1][0]));return {batch:c.batch,index:c.index,gatewayArrivalDeltaMs:Math.abs(gw[0][0]-gw[1][0]),gatewayOverlapMs:ms(gw),lambdaApproximateOverlapMs:ms(lm),lambdaIntervalsFromCompletionLogMs:lm};});
const rows=[...samplePatch.records,...sampleAudit.records].map(c=>({id:c.id,status:c.status,requestId:c.requestId,clientMs:c.latencyMs,gatewayMs:Number(c.gateway[0].responseLatency),lambdaMs:c.lambda[0].elapsedMs,clientTransport:c.clientTransport,platformReport:c.platformReports[0],accountHookMs:c.phases.find(p=>p.phase==='admin-account-hook').durationMs,firstDriverQueryMs:c.phases.find(p=>p.phase==='db-first-query').durationMs,firstConnectionMs:c.phases.find(p=>p.phase==='db-first-connection').durationMs}));
writeFileSync(join(dir,'transport-descriptive.json'),JSON.stringify({scope:'BOUNDED_SAMPLE_DESCRIPTIVE_ONLY',sourceCommit:child.sourceCommit,prefix:child.prefix,p95Accepted:false,rows,pairs},null,2)+'\n');
read('transport-descriptive.json');

const baselineStrict = read('baseline-cold-phases.json'), baselineAnalysis = read('baseline-cold-analysis.json');
demand(Number(readFileSync(join(dir,'baseline-cold-phases.exit'),'utf8').trim())===0 && baselineStrict.coldConflictRequired===true && baselineStrict.coldConflictObservedCount===1 && baselineAnalysis.gate==='PASS' && baselineAnalysis.rows.length===25, 'BASELINE_COLD_PHASE_PROOF');
const baselineCold=patch.records.filter(c=>c.status===409 && c.phases.every(p=>p.coldStart===true) && c.phases.filter(p=>p.phase==='runtime-initialize' && p.outcome==='PASS' && p.errorCode==='NONE').length===1);
demand(baselineCold.length===1 && baselineCold.every(c=>c.platformReports?.length===1 && c.platformReports[0].lambdaRequestId===c.lambda[0].lambdaRequestId && c.platformReports[0].memoryMiB===512 && c.platformReports[0].initDurationMs>0 && Number.isFinite(c.platformReports[0].durationMs)), 'BASELINE_EXACT_PHYSICAL_COLD_REPORT');
demand(baselineAnalysis.bindings.childSha256===bindings['sample.json'] && baselineAnalysis.bindings.patchSha256===bindings['baseline-patch.json'] && baselineAnalysis.bindings.auditSha256===bindings['baseline-audit.json'], 'BASELINE_COLD_ANALYSIS_BINDING');
const physical={gate:'PASS',scope:'ORIGINAL_THREE_ROUNDS_EXACT_COLD409_PLATFORM_AND_PHASE_PROOF',sourceCommit:child.sourceCommit,prefix:child.prefix,count:baselineCold.length,records:baselineCold.map(c=>({id:c.id,requestId:c.requestId,status:c.status,clientMs:c.latencyMs,gatewayMs:Number(c.gateway[0].responseLatency),lambdaMs:c.lambda[0].elapsedMs,platformReport:c.platformReports[0],clientTransport:c.clientTransport,phases:c.phases})),bindings:{childSha256:bindings['sample.json'],patchSha256:bindings['baseline-patch.json'],auditSha256:bindings['baseline-audit.json'],strictPhaseSha256:bindings['baseline-cold-phases.json']},p95Accepted:false};
writeFileSync(join(dir,'baseline-physical-cold-proof.json'),JSON.stringify(physical,null,2)+'\n');
read('baseline-physical-cold-proof.json');

const summary = {
  gate: 'PARTIAL',
  businessGate: 'PASS',
  accountPhaseGate: 'PASS',
  samplingColdConflictGate: coldAccepted ? 'PASS' : 'NOT_OBSERVED',
  baselineColdConflictGate:'PASS', baselineColdConflictObservedCount:baselineCold.length,
  strictSamplingColdPhaseCheck: coldAccepted ? 'PASS' : 'COLD_CONFLICT_REQUIRED',
  scope: 'SAME_SHA_BOUNDED_COLD409_CLIENT_TRANSPORT_AND_OWN_CLEANUP',
  sourceCommit: child.sourceCommit,
  prefix: child.prefix,
  finishedAt: parent.finishedAt,
  fullQa09Accepted: false,
  overallQa09Gate: 'PARTIAL',
  p95Accepted: false,
  performanceDiagnosis: coldAccepted ? 'COLD409_OBSERVED_P95_NOT_ACCEPTED' : 'BASELINE_COLD409_OBSERVED_SAMPLING_WARM_CLIENT_TLS_LONG_TAIL',
  businessChecks: child.checks.length,
  patchLinked: 6,
  auditGetLinked: 19,
  phaseRequests: 25,
  samplingColdConflictObservedCount: samplingPhase.coldConflictObservedCount,
  samplingPatchLinked: 12, samplingAuditGetLinked:18, samplingPhaseRequests:30, sampledContracts:sample.contracts.length, samplingOverlap:pairs,
  cleanup: 'PASS',
  ownedDevicesCleaned: 10,
  ownedSitesCleaned: 2,
  ownedCustomersCleaned: 2,
  ownedIdentitiesCleaned: 5,
  originalDeviceCertificateFingerprintsUnchanged: true,
  outsideBusinessFingerprintsUnchanged: true,
  overlap: overlap(patch.records),
  historicalSibling: race.historical.clientSiblingReceipt,
  bindings,
};
writeFileSync(join(dir, 'target-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
