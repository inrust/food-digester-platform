import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayGate, exactDuplicateGate, dedupGate, sha256 } from './qa09-reliability-closeout.mjs';
import { uniqueReplayProduction } from './qa09-replay-production-proof.mjs';
export function evaluateA5Closeout(parent, r, final, version, hashes) {
  const job = r.jobs?.[0];
  const bound =
    parent.gate === 'PASS' &&
    r.gate === 'PASS_SCOPED_RELIABILITY' &&
    r.prefix === parent.prefix &&
    /^qa09-[a-f0-9]{16}$/.test(parent.prefix ?? '') &&
    r.sourceCommit === parent.sourceCommit &&
    parent.sourceCommit === version.sourceCommit &&
    version.gate === 'PASS' &&
    version.lambdaArtifacts?.length === 19 &&
    version.lambdaArtifacts.every((row) => row.matches === true) &&
    r.versionSha256 === hashes.version &&
    final.parentSha256 === hashes.parent &&
    final.prefix === parent.prefix &&
    final.sourceCommit === parent.sourceCommit &&
    final.gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
    !parent.cleanupHold &&
    !parent.cleanup?.some((row) => row.result !== 'PASS') &&
    r.activeRequired === false &&
    r.before?.devices?.length === 10 &&
    r.after?.devices?.length === 10 &&
    [...r.before.devices, ...r.after.devices].every((row) => row.lifecycle_status !== 'Active') &&
    parent.published?.some(
      (row) =>
        row.deviceId === r.expected?.deviceId &&
        row.messageId === r.expected.messageId &&
        row.bodySha256 === r.expected.rawBodySha256,
    ) &&
    r.businessCleanup === 'PASS' &&
    r.operator?.realSrp === true &&
    r.operator.businessDisabled === true &&
    r.operator.cognitoDeleted === true &&
    r.operatorCleanup?.gate === 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED';
  const operator =
    bound &&
    r.jobs.length === 1 &&
    job.role === 'PlatformOperator' &&
    job.requestedBy === r.operator.userId &&
    replayGate(job.view, job.scope) === 'PASS_NONEMPTY_EXACT_SCOPE_REPLAY' &&
    ['replay.job.create', 'replay.job.execute'].every((action) =>
      r.after.audits?.some((row) => row.object_id === job.jobId && row.action === action && row.result === 'SUCCESS'),
    );
  const produced =
    job &&
    r.expected &&
    uniqueReplayProduction(r.production?.rows ?? [], { ...r.expected, jobId: job.jobId, topicType: 'telemetry' });
  const unique =
    operator &&
    produced.gate === 'PASS_UNIQUE_REPLAY_JOB_PRODUCTION' &&
    exactDuplicateGate(r.replayConsumption?.rows ?? [], { ...r.expected, sqsMessageId: produced.sqsMessageId }) ===
      'PASS_EXACT_DUPLICATE_CONSUMPTION' &&
    r.submission?.ssoSendAttempts === 0;
  const dedup =
    unique &&
    r.dailyWait?.gate === 'PASS_NATURAL_OWN_DAILY_VISIBLE' &&
    r.dailyWait.sharedWorkerInvocations === 0 &&
    r.dailyWait.deviceId === r.expected.deviceId &&
    dedupGate(r.before, r.after) === 'PASS_NO_RECEIPT_AGGREGATE_OR_ARCHIVE_DUPLICATION';
  const closed = [
    ['replay.operatorNonempty', operator],
    ['replay.uniqueProducerAssociation', unique],
    ['reliability.sameRunNonemptyDedup', dedup],
  ].map(([id, ok]) => ({ id, status: ok ? 'PASS_SCOPED_TARGET' : 'NO_COMPLETE_RECEIPT' }));
  return {
    gate: closed.every((row) => row.status === 'PASS_SCOPED_TARGET')
      ? 'PASS_THREE_A5_SUPPLEMENTAL_CRITERIA'
      : 'PARTIAL',
    prefix: parent.prefix,
    applicationCommit: parent.sourceCommit,
    closed,
    remainingA5Mandatory: [
      'reliability.archivePartialFailure',
      'reliability.queueAndScheduleAssociation',
      'Remaining applicable MQTT message types from the frozen formal probes',
    ],
    a2Gate: 'BLOCKED_PENDING_AUTHORIZED_CONTROLLED_VERIFIER_AND_SIGNER',
    fullA5Accepted: false,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [parentPath, finalPath, versionPath, output] = process.argv.slice(2);
  if (!parentPath || !finalPath || !versionPath || !output) throw Error('PARENT_FINAL_VERSION_OUTPUT_REQUIRED');
  const paths = [parentPath, parentPath + '.reliability.json', finalPath, versionPath];
  const values = paths.map((path) => JSON.parse(readFileSync(path)));
  const result = {
    ...evaluateA5Closeout(...values, {
      parent: sha256(readFileSync(parentPath)),
      version: sha256(readFileSync(versionPath)),
    }),
    checkedAt: new Date().toISOString(),
    checkerSha256: sha256(readFileSync(new URL(import.meta.url))),
    bindings: paths.map((path) => ({ path, sha256: sha256(readFileSync(path)) })),
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ gate: result.gate, closed: result.closed }));
  process.exitCode = result.gate === 'PASS_THREE_A5_SUPPLEMENTAL_CRITERIA' ? 0 : 1;
}
