import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  sha256,
  assertArchiveAssociation,
  assertNaturalSummary,
  assertPartialBatch,
} from './qa09-minimum-a5-proof.mjs';
const read = (path) => JSON.parse(readFileSync(path));
export function checkMinimumA5(parentPath, finalPath, output) {
  const p = read(parentPath),
    final = read(finalPath),
    frozen = read(parentPath + '.sources.json');
  const version = read(p.versionReceipt),
    scope = read('infra/environments/qa09-minimum-cloud.json');
  const require = (condition, code) => {
    if (!condition) throw Error(code);
  };
  require(p.gate === 'PASS' &&
    p.remainingA5Gate === 'PASS_MINIMUM_SCOPE' &&
    p.remainingOnly === true &&
    !p.cleanupHold &&
    p.finishedAt &&
    p.checks.every((c) => c.result === 'PASS'), 'COMPLETE_MINIMUM_EXECUTION_REQUIRED');
  require(version.gate === 'PASS' &&
    version.sourceCommit === p.sourceCommit &&
    version.lambdaArtifacts.length === 19 &&
    version.lambdaArtifacts.every((a) => a.matches === true), 'CURRENT_VERIFIED_APPLICATION_REQUIRED');
  require(frozen.sources.every((s) => s.sha256 === sha256(Buffer.from(s.sourceBase64, 'base64'))) &&
    frozen.sources.find((s) => s.path === 'scripts/run-qa09-ten-device-acceptance.mjs')?.sha256 ===
      p.executorSha256, 'FROZEN_EXECUTOR_REQUIRED');
  require(final.gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
    final.prefix === p.prefix &&
    final.parentSha256 === sha256(readFileSync(parentPath)) &&
    final.sourceCommit === p.sourceCommit &&
    final.businessWrites === 0 &&
    final.iamKmsOrCapacityWrites === 0 &&
    final.reads.every((r) => r.result === 'PASS') &&
    final.identities.length === 1 &&
    final.identities.every((r) => r.count === 0) &&
    final.archives.length === 12 &&
    final.archives.every((r) => r.versions === 0 && r.markers === 0 && !r.truncated), 'INDEPENDENT_CLEANUP_REQUIRED');
  const empty = read(final.databaseReceipt);
  require(sha256(readFileSync(final.databaseReceipt)) === final.databaseSha256 &&
    empty.gate === 'PASS' &&
    empty.result.empty &&
    empty.result.emptyCounts?.length === 14 &&
    empty.result.emptyCounts.every((r) => r.count === 0), 'EXACT_EMPTY_DATABASE_REQUIRED');
  const sourceHash = frozen.sources.find((s) => s.path === 'scripts/qa09-ten-device-db.mjs')?.sha256;
  const observations = p.databaseBuilds.map((b) => {
    const r = read(b.receipt);
    require(r.gate === 'PASS' &&
      r.sourceHash === sourceHash &&
      read(b.receipt + '.preparation.json').plan.prefix === p.prefix &&
      r.build.id === b.buildId, 'BOUND_DATABASE_BUILDS_REQUIRED');
    return { ...r, action: b.action };
  });
  const current = observations.filter((b) => b.action === 'consistency-observe').at(-1)?.result;
  require(current &&
    current.devices.length === 10 &&
    current.devices.every((d) => d.lifecycle_status === 'Onboarded'), 'REAL_NONACTIVE_SCOPE_REQUIRED');
  const published = p.published.filter((r) => r.type !== 'heartbeat');
  require(published.length === 4 &&
    new Set(published.map((r) => r.type)).size === 4, 'EXACT_REMAINING_MESSAGES_REQUIRED');
  assertArchiveAssociation(published, current.outbox, p.archiveLogs, p.normalArchiveObjects);
  assertNaturalSummary(current.telemetry_daily, p.summaryLogs, {
    deviceId: p.devices[0],
    customerId: p.customers[0].id,
    notBefore: p.remainderStartedAt,
    ruleName: 'fdp-test-summary',
  });
  require(p.partialBatch.state === 'TERMINAL' &&
    p.partialBatch.invoke.status === 200 &&
    !p.partialBatch.invoke.functionError &&
    p.partialBatch.object?.eventId === p.partialBatch.eventId &&
    p.partialBatch.object?.versionId &&
    p.partialBatch.provenance ===
      'DIRECT_LAMBDA_HANDLER_SYNTHETIC_RECORD_IDS_NOT_SQS_DELIVERY', 'DEPLOYED_PARTIAL_BATCH_REQUIRED');
  assertPartialBatch(p.partialBatch.response, p.partialBatch.badIds, p.partialBatch.goodIds);
  require(scope.newChannelsRequired === false &&
    scope.newIamRolesRequired === false &&
    scope.iamKmsOrSharedPermissionChangesAllowed === false, 'NO_NEW_PERMISSION_SCOPE_REQUIRED');
  const summary = {
    scope: scope.scope,
    gate: 'PASS_TWO_REMAINING_A5_MINIMUM_CRITERIA',
    applicationCommit: p.sourceCommit,
    closed: ['reliability.archivePartialFailure', 'reliability.queueAndScheduleAssociation'],
    queue: p.archiveQueueProof,
    summary: p.summaryProof,
    partialBatch: p.partialBatch.proof,
    extraSignalTypes: ['alarm', 'event', 'tamper'],
    cleanup: {
      gate: final.gate,
      ownCertificatesDeleted: p.cleanup.filter((r) => r.type === 'iot-certificate' && r.result === 'PASS').length,
      ownThingsDeleted: p.cleanupOperations.filter(
        (r) => r.operation === 'aws:DeleteThingCommand' && r.result === 'PASS',
      ).length,
      customersDeleted: p.cleanup.filter((r) => r.type === 'customer' && r.result === 'PASS').length,
      rawPrefixesVerifiedEmpty: final.archives.length,
      databaseTablesVerifiedEmpty: empty.result.emptyCounts.length,
      successfulBuildsVerified: final.builds.length,
    },
    fullA5OriginalScopeAccepted: false,
    fullQa09Accepted: false,
    minimumQa09Accepted: false,
    productionReady: false,
    noIamKmsOrCapacityChanges: true,
    checkedAt: new Date().toISOString(),
    fullEvidenceLocalOnly: true,
    localBindings: [
      parentPath,
      finalPath,
      p.versionReceipt,
      parentPath + '.sources.json',
      ...p.databaseBuilds.map((b) => b.receipt),
      final.databaseReceipt,
    ].map((path) => ({ file: path.split('/').at(-1), sha256: sha256(readFileSync(path)) })),
  };
  require(summary.cleanup.ownCertificatesDeleted === 10 &&
    summary.cleanup.ownThingsDeleted === 10 &&
    summary.cleanup.customersDeleted === 2 &&
    p.cleanup.every((r) => r.result === 'PASS'), 'EXACT_OWN_RESOURCE_CLEANUP_REQUIRED');
  writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  checkMinimumA5(...process.argv.slice(2));
