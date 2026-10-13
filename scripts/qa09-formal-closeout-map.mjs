import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareApplicationInputs } from './collect-qa09-business-reconciliation.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export const FORMAL_VALIDATORS = [
  'check-aws-iot-data-path-evidence.mjs',
  'check-aws-data-processing-evidence.mjs',
  'check-aws-admin-cus-dev-evidence.mjs',
  'check-aws-admin-business-evidence.mjs',
  'check-aws-med-rbac-aud-dash-set-evidence.mjs',
  'check-admin-web-target-evidence.mjs',
  'check-admin-web-fe11-15-target-evidence.mjs',
  'check-admin-web-fe16-19-target-evidence.mjs',
];
export function assertScopedSources(parent, child, final, version) {
  if (
    !/^[a-f0-9]{40}$/.test(version.sourceCommit ?? '') ||
    !/^qa09-[a-f0-9]{16}$/.test(parent.prefix ?? '') ||
    parent.sourceCommit !== version.sourceCommit ||
    child.sourceCommit !== version.sourceCommit ||
    final.sourceCommit !== version.sourceCommit ||
    parent.prefix !== child.prefix ||
    parent.prefix !== final.prefix ||
    !parent.finishedAt ||
    !child.finishedAt ||
    parent.cleanupHold ||
    child.businessCleanup !== 'PASS' ||
    version.gate !== 'PASS' ||
    version.lambdaArtifacts?.length !== 19 ||
    version.lambdaArtifacts.some((a) => !a.matches) ||
    final.gate !== 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' ||
    child.fullQa09Accepted !== false
  )
    throw Error('SCOPED_SOURCE_BINDING_REQUIRED');
  return { fullQa09Accepted: false, productionReady: false, formalAccepted: false };
}
export async function mapFormalCloseout(parentPath, finalPath, versionPath, output) {
  if (existsSync(output)) throw Error('FRESH_FORMAL_MAPPING_REQUIRED');
  const bindings = [];
  const read = (path) => {
    const b = readFileSync(path);
    bindings.push({ path, sha256: hash(b) });
    return JSON.parse(b);
  };
  const parent = read(parentPath),
    child = read(parentPath + '.reliability.json'),
    final = read(finalPath),
    version = read(versionPath);
  const exclusions = assertScopedSources(parent, child, final, version);
  if (child.versionSha256 !== hash(readFileSync(versionPath)) || final.parentSha256 !== hash(readFileSync(parentPath)))
    throw Error('SCOPED_SOURCE_BYTES_DRIFT');
  const results = [];
  const historicalPath = 'docs/audit/evidence/qa-09-close-07-2026-10-13/target-v2.json.reliability.json';
  const historical = read(historicalPath);
  const historicalComparison = compareApplicationInputs(historical.sourceCommit, version.sourceCommit);
  const historicalReliability = {
    path: historicalPath,
    sourceCommit: historical.sourceCommit,
    originalGate: historical.gate,
    replayGate: historical.replayGate,
    duplicateConsumerGate: historical.replayConsumption?.gate,
    directSendGate: historical.submission?.gate,
    fullDedupGate: historical.dedupGate,
    producerToSpecificSqsIdClaimed: historical.replayProducerToSpecificSqsIdClaimed,
    compatibility: historicalComparison.every((row) => row.equal)
      ? 'SOURCE_INPUTS_EQUAL_HISTORICAL_CONFIG_AND_SCOPE_NOT_CURRENT_FORMAL_ACCEPTANCE'
      : 'REVALIDATE_CHANGED_INPUTS',
    comparison: historicalComparison,
    currentFormalPassClaimed: false,
  };
  for (const name of FORMAL_VALIDATORS) {
    const path = 'scripts/' + name,
      module = await import(pathToFileURL(resolve(path)));
    // Enumerate every exported required set. Ancillary schema constraints still belong to the original validator.
    const required = Object.fromEntries(
      Object.entries(module).filter(
        ([k]) => k.startsWith('REQUIRED_') || ['UPLINK_TYPES', 'QA03_PROBES', 'RETIRED_MQTT_TYPES'].includes(k),
      ),
    );
    const run = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
    if (run.error || run.signal) throw Error('FORMAL_VALIDATOR_DID_NOT_COMPLETE');
    results.push({
      validator: path,
      validatorSha256: hash(readFileSync(path)),
      required,
      exitCode: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      gate: run.status === 0 ? 'PASS' : 'FORMAL_GATE_NOT_SATISFIED',
      ancillaryConstraints: 'UNMODIFIED_VALIDATOR_AND_REFERENCED_SCHEMA_REQUIRED',
      cloudRequests: 0,
    });
  }
  const candidates =
    child.gate === 'PASS_SCOPED_ESG_LEASE_AND_CONSISTENCY'
      ? [
          {
            formalProbe: 'archive.outbox',
            proof: 'consistency',
            scope: '22 own ARCHIVE outbox hashes and PUBLISHED state; queue hop not proven',
          },
          {
            formalProbe: 'archive.s3Object / archive.manifest',
            proof: 'archive',
            scope: '22 own real MQTT raw messages and gzip/manifest binding; partial failure not proven',
          },
          {
            formalProbe: 'summary.hourly / summary.daily / summary.esgDaily',
            proof: 'finalConsistency',
            scope:
              '10 own telemetry daily rows and 2 simulated-device Report ESG rows; no third-party carbon verification',
          },
          {
            formalProbe: 'esgExport.expiredProcessingRecovered',
            proof: 'leaseRecovery',
            scope: 'one own completed export, expired lease, natural recovery and equal nonempty CSV',
          },
          {
            formalProbe: 'createEsgExport / getEsgExport',
            proof: 'jobs',
            scope: 'four nonempty datasets, one PlatformSuperAdmin; other role paths not covered',
          },
        ].map((row) => ({
          ...row,
          gate: 'SCOPED_CANDIDATE_REQUIRES_FORMAL_ASSEMBLY',
          source: parentPath + '.reliability.json',
        }))
      : [];
  if (
    candidates.length &&
    (!child.consistency?.gate.startsWith('PASS_') ||
      !child.finalConsistency?.gate.startsWith('PASS_') ||
      child.archive?.gate !== 'PASS' ||
      !child.leaseRecovery?.gate.startsWith('PASS_') ||
      child.jobs.length !== 4 ||
      child.jobs.some((j) => j.csv?.gate !== 'PASS_NONEMPTY_CSV_DATABASE_EQUAL'))
  )
    throw Error('SCOPED_CANDIDATE_PROOF_REQUIRED');
  const result = {
    task: 'QA09-CLOSE-08',
    gate: 'PARTIAL_FORMAL_MAPPING_ONLY',
    sourceCommit: version.sourceCommit,
    repositoryCommitAtCheck: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    actualEnvironment: {
      accountId: '065986019555',
      region: 'ap-southeast-1',
      kind: 'EXISTING_TEST_ENVIRONMENT',
      isolated: false,
    },
    ...exclusions,
    formalPassCount: results.filter((r) => r.exitCode === 0).length,
    formalRequiredCount: 8,
    results,
    candidates,
    historicalReliability,
    bindings,
    remaining: [
      'Formal receipts absent or incomplete; original validators remain authoritative',
      'Legacy AWS schema requires isolated=true; explicit existing-test-environment schema change is still required, no false flag',
      'All operations/roles, other MQTT uplinks, archive partial failure, exact queue hops and Replay producer association remain separate gaps',
      'Natural schedule data appearance does not alone identify a schedule invocation or Lambda request ID',
      'Browser journeys, lifecycle/Active, trusted firmware, notification boundaries and release performance remain unclosed',
    ],
    originalFailuresAndUnknownStartsPreserved: true,
    noMutationRetries: true,
    iamKmsChanges: false,
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await mapFormalCloseout(...process.argv.slice(2))));
