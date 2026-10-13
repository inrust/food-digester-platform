import { canonicalizeJson } from '../contracts/mqtt/payload-normalization.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, logRows, assertPartialBatch } from './qa09-minimum-a5-proof.mjs';
import { assertDirectPartialAssociation } from './check-qa09-minimum-a5.mjs';
import { archiveQueueWriteAssociation } from './qa09-minimum-association-gate.mjs';
import { naturalSummaryBusinessAssociation } from './qa09-natural-summary-association.mjs';
import { gunzipSync } from 'node:zlib';
const read = (p) => JSON.parse(readFileSync(p));
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
export function checkMinimumAssociations(dir, output) {
  const path = (n) => dir + n,
    p = read(path('target-v3.json')),
    version = read(path('application-version.json')),
    final = read(path('v3-final-readonly.json')),
    natural = read(path('natural-summary-association.json')),
    mixed = read(path('mixed-minimum.json')),
    reader = read(mixed.readerReceipt),
    compat = read(path('compatibility.json')),
    prior = read(path('prior-a5-recheck.json'));
  demand(
    version.gate === 'PASS' &&
      version.sourceCommit === p.sourceCommit &&
      version.lambdaArtifacts.length === 19 &&
      version.lambdaArtifacts.every((r) => r.matches),
    'VERIFIED_CURRENT_APPLICATION_REQUIRED',
  );
  demand(
    final.gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
      final.parentSha256 === sha256(readFileSync(path('target-v3.json'))) &&
      final.archiveReader?.gate === 'PASS_INDEPENDENTLY_ABSENT_AND_EXISTING_POLICY_UNCHANGED',
    'INDEPENDENT_NORMAL_RUN_CLEANUP_REQUIRED',
  );
  const db = read(p.databaseBuilds.filter((b) => b.action === 'consistency-observe').at(-1).receipt),
    frozen = read(path('target-v3.json.sources.json'));
  demand(
    db.sourceHash === frozen.sources.find((s) => s.path === 'scripts/qa09-ten-device-db.mjs').sha256 &&
      db.build.id === p.databaseBuilds.filter((b) => b.action === 'consistency-observe').at(-1).buildId,
    'FROZEN_NORMAL_DATABASE_PROOF_REQUIRED',
  );
  const queue = archiveQueueWriteAssociation(p, db.result, logRows(read(path('v3-archive-consumer-logs.json')).events));
  demand(
    natural.applicationCommit === p.sourceCommit &&
      natural.bindings.every((b) => sha256(readFileSync(b.path)) === b.sha256),
    'BOUND_SAME_APPLICATION_NATURAL_PROOF_REQUIRED',
  );
  const summary = naturalSummaryBusinessAssociation(
    read(natural.parentPath),
    read(natural.beforePath).result,
    read(natural.cleanupPath).result,
    natural.rows,
  );
  demand(
    mixed.gate === 'PASS_REAL_MIXED_HANDLER_AND_GET_OBJECT_READBACK' &&
      mixed.applicationCommit === p.sourceCommit &&
      mixed.cleanup.length === 1 &&
      mixed.cleanup[0].result === 'PASS' &&
      mixed.cleanup[0].deleted === 2 &&
      reader.gate === 'PASS' &&
      reader.cleanup.length === 2 &&
      reader.cleanup.every((c) => c.result === 'PASS'),
    'ACTUAL_MIXED_BATCH_AND_READER_CLEANUP_REQUIRED',
  );
  const input = read(path('mixed-minimum.input.json')),
    response = read(path('mixed-minimum.response.json')),
    executedSource = read(path('mixed-minimum.source.json'));
  demand(
    executedSource.path === 'scripts/run-qa09-archive-mixed-minimum.mjs' &&
      sha256(Buffer.from(executedSource.sourceBase64, 'base64')) === executedSource.sha256,
    'EXACT_EXECUTED_MIXED_SOURCE_SNAPSHOT_REQUIRED',
  );
  demand(
    sha256(readFileSync(path('mixed-minimum.input.json'))) === mixed.inputSha256 &&
      JSON.stringify(response) === JSON.stringify(mixed.response),
    'FROZEN_DIRECT_INPUT_AND_RESPONSE_REQUIRED',
  );
  assertPartialBatch(response, mixed.badIds, mixed.goodIds);
  const a = reader.result.objects.find((o) => o.key === mixed.object.key),
    m = reader.result.objects.find((o) => o.key === mixed.object.manifestKey),
    bytes = Buffer.from(a.bodyBase64, 'base64'),
    manifestBytes = Buffer.from(m.bodyBase64, 'base64'),
    manifest = JSON.parse(manifestBytes),
    rows = gunzipSync(bytes).toString().trim().split('\n').map(JSON.parse);
  demand(
    a.versionId === mixed.object.versionId &&
      m.versionId === mixed.object.manifestVersionId &&
      sha256(bytes) === mixed.object.compressedSha256 &&
      sha256(manifestBytes) === mixed.object.manifestSha256 &&
      manifest.sha256 === sha256(bytes) &&
      manifest.recordCount === 1 &&
      manifest.eventIds.length === 1 &&
      manifest.eventIds[0] === mixed.eventId &&
      rows.length === 1 &&
      rows[0].eventId === mixed.eventId,
    'EXACT_DIRECT_OBJECT_MANIFEST_AND_RESPONSE_VERSIONS_REQUIRED',
  );
  const good = JSON.parse(input.Records.find((r) => r.messageId === mixed.goodIds[0]).body);
  demand(
    rows[0].rawBody === good.payload.rawBody &&
      canonicalizeJson(rows[0].payload) === canonicalizeJson(good.payload.payload),
    'ACTUAL_DIRECT_ARCHIVED_CONTENT_MATCHES_INPUT',
  );
  const direct = assertDirectPartialAssociation(
    { eventId: mixed.eventId, goodIds: mixed.goodIds, object: mixed.object },
    mixed.directLogs,
  );
  demand(
    prior.gate === 'PASS_THREE_A5_SUPPLEMENTAL_CRITERIA' &&
      prior.closed.length === 3 &&
      prior.closed.every((c) => c.status === 'PASS_SCOPED_TARGET') &&
      sha256(readFileSync(path('prior-a5-recheck.json'))) === compat.priorRecheckSha256 &&
      compat.newApplication === p.sourceCommit &&
      [
        'fdp-test-api',
        'fdp-test-ingestion',
        'fdp-test-replay',
        'fdp-test-replay-trigger-publisher',
        'fdp-test-outbox-publisher',
      ].every((name) => compat.lambdaCodeCompatibility.find((f) => f.name === name)?.codeUnchanged === true),
    'COMPATIBLE_PRIOR_THREE_CRITERIA_REQUIRED',
  );
  const current = read(path('final-runtime-two-functions.json'));
  demand(
    current.length === 2 &&
      current.every(
        (c) =>
          c.state === 'Active' &&
          c.update === 'Successful' &&
          version.lambdaArtifacts.some((a) => a.name === c.name && a.codeSha256 === c.sha),
      ),
    'CURRENT_ARCHIVE_AND_SUMMARY_CODE_REQUIRED',
  );
  const v4 = read(path('v4-final-readonly.json'));
  demand(
    v4.gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
      v4.parentSha256 === sha256(readFileSync(path('target-v4.json'))),
    'FAILED_EXTRA_RUN_CLEANUP_REQUIRED',
  );
  demand(
    read(path('first-final-readonly-v2.json')).gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
      read(path('v2-unseeded-audit.json')).result.devices.length === 0 &&
      read(path('additional-identities-absent.json')).gate === 'PASS_ADDITIONAL_TEMPORARY_IDENTITIES_ABSENT' &&
      read(path('v2-start-reconciliation.json')).gate === 'PASS_UNIQUE_CLOUDTRAIL_START_REJECTED_NO_BUILD',
    'ALL_ATTEMPTS_CLEANUP_REQUIRED',
  );
  demand(
    read(path('mixed-final-readonly.json')).gate === 'PASS_INDEPENDENT_MIXED_EMPTY_ABSENT_AND_ROLE_UNCHANGED',
    'INDEPENDENT_FINAL_MIXED_CLEANUP_REQUIRED',
  );
  const files = [
    'target-v3.json',
    'v3-final-readonly.json',
    'v3-archive-consumer-logs.json',
    'natural-summary-association.json',
    'mixed-minimum.json',
    'mixed-final-readonly.json',
    'mixed-minimum.input.json',
    'mixed-minimum.response.json',
    'mixed-minimum.source.json',
    'application-version.json',
    'compatibility.json',
    'prior-a5-recheck.json',
    'v4-final-readonly.json',
    'first-final-readonly-v2.json',
    'v2-unseeded-audit.json',
    'additional-identities-absent.json',
    'v2-start-reconciliation.json',
    'final-runtime-two-functions.json',
  ];
  const result = {
    gate: 'PASS_FIVE_MINIMUM_A5_SUPPLEMENTAL_CRITERIA',
    scope: 'MINIMUM_A5_ASSOCIATIONS_AND_DIRECT_HANDLER_PARTIAL_BATCH',
    applicationCommit: p.sourceCommit,
    closed: [
      ...prior.closed.map((c) => ({ ...c, status: 'PASS_COMPATIBLE_SCOPED_TARGET' })),
      { id: 'reliability.archivePartialFailure', status: 'PASS_DIRECT_DEPLOYED_HANDLER_AND_REAL_S3_READBACK' },
      {
        id: 'reliability.queueAndScheduleAssociation',
        status: 'PASS_ACTUAL_NORMAL_QUEUE_AND_NATURAL_BUSINESS_ASSOCIATION',
      },
    ],
    normalQueue: queue,
    naturalSummary: summary,
    partialBatch: {
      ...mixed.partialProof,
      association: direct,
      logicalObjects: 1,
      realObjectAndManifestHashesVerified: true,
    },
    extraRealSignalTypes: ['alarm', 'event', 'tamper'],
    cleanup: {
      allAttempts: 'PASS_INDEPENDENT_OWN_EMPTY_AND_TERMINAL_READS',
      normalRun: final.gate,
      extraFailedRun: v4.gate,
      mixedObjectVersionsDeleted: 2,
      mixedReaderDeleted: true,
      existingRolePolicyUnchanged: true,
    },
    a2Gate: 'MATERIAL_PENDING_NO_NEW_PERMISSION_CHANNEL',
    releaseRequired: [
      'REAL_CURRENT_LICENSE_SIGNATURE_VERIFICATION',
      'REAL_TARGET_TRUSTED_SIGNED_PACKAGE_VERIFICATION',
      'ACTUAL_POISON_RETRY_AND_DLQ_ROUTING_RECOVERY_IN_SAFE_SCOPE',
    ],
    fullA5OriginalScopeAccepted: false,
    fullQa09Accepted: false,
    minimumQa09Accepted: false,
    productionReady: false,
    newIamRolesOrA2ChannelsCreated: false,
    iamKmsOrSharedCapacityConfigurationChanges: false,
    originalFailuresPreserved: true,
    checkedAt: new Date().toISOString(),
    fullEvidenceLocalOnly: true,
    localBindings: [
      ...files.map((n) => ({ file: n, sha256: sha256(readFileSync(path(n))) })),
      { file: mixed.readerReceipt.split('/').at(-1), sha256: sha256(readFileSync(mixed.readerReceipt)) },
    ],
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(checkMinimumAssociations(...process.argv.slice(2)).gate);
