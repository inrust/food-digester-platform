import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayGate, exactDuplicateGate, dedupGate, sha256 } from './qa09-reliability-closeout.mjs';
import { bindOwnOperatorActor } from './collect-qa09-operator-actor-binding.mjs';
import { uniqueReplayProduction } from './qa09-replay-production-proof.mjs';
import { verifyA5RecoveryReceipt } from './recover-qa09-a5-cleanup.mjs';
export function evaluateA5Closeout(parent, r, final, version, hashes) {
  const job = r.jobs?.[0];
  const actor = hashes.actorBinding;
  const recovery = hashes.recovery;
  const recovered =
    hashes.recoveryFilesVerified === true &&
    recovery?.gate === 'PASS_RECOVERED_OWN_A5_CLEANUP' &&
    final.recovery?.sha256 === hashes.recoveryHash &&
    recovery.prefix === parent.prefix;
  const actorBound =
    hashes.actorBindingFilesVerified === true &&
    actor?.gate === 'PASS_REAL_COGNITO_SUB_TO_OWN_DATABASE_USER' &&
    actor.prefix === parent.prefix &&
    actor.applicationCommit === parent.sourceCommit &&
    actor.businessUserId === r.operator?.userId &&
    actor.email === r.operator?.email &&
    JSON.stringify(actor.groups) === JSON.stringify(['PlatformOperator']);
  const executionComplete =
    r.gate === 'PASS_SCOPED_RELIABILITY' ||
    ((r.gate === 'PARTIAL' || (r.gate === 'FAIL' && recovered)) &&
      r.operatorActorGate === 'NO_RECEIPT' &&
      actorBound &&
      r.replayGate === 'PASS_NONEMPTY_EXACT_SCOPE_REPLAY' &&
      r.queueConsumptionGate === 'PASS_EXACT_DUPLICATE_CONSUMPTION' &&
      r.dedupGate === 'PASS_NO_RECEIPT_AGGREGATE_OR_ARCHIVE_DUPLICATION' &&
      r.replayAuditGate === 'PASS');
  const bound =
    (parent.gate === 'PASS' || recovered) &&
    executionComplete &&
    !r.failure &&
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
    (recovered || (!parent.cleanupHold && !parent.cleanup?.some((row) => row.result !== 'PASS'))) &&
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
    (recovery?.businessCleanup ?? r.businessCleanup) === 'PASS' &&
    r.operator?.realSrp === true &&
    (recovered || (r.operator.businessDisabled === true && r.operator.cognitoDeleted === true)) &&
    (recovered ? recovery.operatorCleanup : r.operatorCleanup)?.gate === 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED';
  const operator =
    bound &&
    r.jobs.length === 1 &&
    job.role === 'PlatformOperator' &&
    actorBound &&
    job.requestedBy === actor.actorId &&
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
    originalExecutionGate: r.gate,
    originalParentGate: parent.gate,
    cleanupRecoveryGate: recovered ? recovery.gate : null,
    actorBindingGate: actorBound ? actor.gate : 'NO_COMPLETE_ACTOR_BINDING',
    actorIdentifierRule: 'requestedBy is signed Cognito sub; database userId remains the disable/readback identifier',
    closed,
    remainingA5Mandatory: [
      'reliability.archivePartialFailure',
      'reliability.queueAndScheduleAssociation',
      'Remaining applicable MQTT message types from the frozen formal probes',
    ],
    a2Gate: 'BLOCKED_EXTERNAL_OPERATIONS_AUTHORITY',
    fullA5Accepted: false,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [parentPath, finalPath, versionPath, output, actorPath, recoveryPath] = process.argv.slice(2);
  if (!parentPath || !finalPath || !versionPath || !output) throw Error('PARENT_FINAL_VERSION_OUTPUT_REQUIRED');
  const paths = [parentPath, parentPath + '.reliability.json', finalPath, versionPath];
  const values = paths.map((path) => JSON.parse(readFileSync(path)));
  if (!actorPath) throw Error('INDEPENDENT_OPERATOR_ACTOR_BINDING_REQUIRED');
  const actor = JSON.parse(readFileSync(actorPath));
  const recovery = recoveryPath ? verifyA5RecoveryReceipt(parentPath, recoveryPath) : null;
  const [parent, r] = values;
  const seedPath = parentPath + '.seed-PlatformOperator.json';
  const actorBoundPaths = [seedPath, seedPath + '.preparation.json', versionPath];
  if (
    actor.readerSha256 !== sha256(readFileSync('scripts/collect-qa09-operator-actor-binding.mjs')) ||
    actor.bindings?.length !== actorBoundPaths.length ||
    actor.bindings.some((row, i) => row.path !== actorBoundPaths[i] || row.sha256 !== sha256(readFileSync(row.path))) ||
    !(
      Date.parse(actor.observedAt) >= Date.parse(r.startedAt) &&
      Date.parse(actor.observedAt) <= Date.parse(r.finishedAt)
    )
  )
    throw Error('OPERATOR_ACTOR_SOURCE_OR_RECEIPT_DRIFT');
  const prep = JSON.parse(readFileSync(seedPath + '.preparation.json')),
    seed = JSON.parse(readFileSync(seedPath));
  const frozen = JSON.parse(readFileSync(parentPath + '.sources.json'));
  if (
    prep.sourceHash !== frozen.sources.find((row) => row.path === 'scripts/qa09-ten-device-db.mjs')?.sha256 ||
    sha256(prep.project.source.buildspec) !== prep.buildspecHash ||
    !r.fixtureBuilds.some((row) => row.buildId === seed.build.id && row.sha256 === sha256(readFileSync(seedPath))) ||
    !values[2].builds.some((row) => row.id === seed.build.id && row.status === 'SUCCEEDED')
  )
    throw Error('OPERATOR_SEED_BUILD_NOT_BOUND');
  const mapped = bindOwnOperatorActor(
    parent,
    r,
    prep,
    seed,
    { enabled: true, status: 'CONFIRMED', email: actor.email, subject: actor.actorId },
    actor.groups,
  );
  if (Object.entries(mapped).some(([key, value]) => JSON.stringify(actor[key]) !== JSON.stringify(value)))
    throw Error('OPERATOR_ACTOR_MAPPING_DRIFT');
  paths.push(actorPath, ...actorBoundPaths.slice(0, 2), parentPath + '.sources.json');
  if (recoveryPath) paths.push(recoveryPath);
  const result = {
    ...evaluateA5Closeout(...values, {
      parent: sha256(readFileSync(parentPath)),
      version: sha256(readFileSync(versionPath)),
      actorBinding: actor,
      actorBindingFilesVerified: true,
      recovery,
      recoveryHash: recoveryPath ? sha256(readFileSync(recoveryPath)) : null,
      recoveryFilesVerified: recovery !== null,
    }),
    checkedAt: new Date().toISOString(),
    checkerSha256: sha256(readFileSync(new URL(import.meta.url))),
    bindings: paths.map((path) => ({ path, sha256: sha256(readFileSync(path)) })),
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ gate: result.gate, closed: result.closed }));
  process.exitCode = result.gate === 'PASS_THREE_A5_SUPPLEMENTAL_CRITERIA' ? 0 : 1;
}
