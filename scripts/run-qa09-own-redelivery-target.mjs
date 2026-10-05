import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runOwnSuperExports } from './qa09-own-super-exports.mjs';
import { withFreshOwnMqttSession } from './qa09-own-mqtt-session.mjs';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { redeliverOwnProcessedTelemetry } from './qa09-own-queue-redelivery.mjs';
import { collectDataPathEvidence } from './qa09-data-path-evidence.mjs';
import { computeAuditHash } from '../contracts/mqtt/payload-normalization.ts';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [output, version, mode] = process.argv.slice(2);
if (mode !== undefined && mode !== '--queue-only') throw Error('INVALID_REDELIVERY_MODE');
const queueOnly = mode === '--queue-only';
if (!output || !version) throw Error('OUTPUT_VERSION_REQUIRED');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const paths = [
  'scripts/run-qa09-own-redelivery-target.mjs',
  'scripts/qa09-own-super-exports.mjs',
  'scripts/qa09-own-mqtt-session.mjs',
  'scripts/qa09-business-target.mjs',
  'pnpm-lock.yaml',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-own-queue-redelivery.mjs',
  'scripts/qa09-data-path-evidence.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'scripts/qa09-own-s3-cli.mjs',
  'contracts/mqtt/payload-normalization.ts',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      sources: paths.map((path) => ({
        path,
        sha256: hash(readFileSync(path)),
        sourceBase64: readFileSync(path).toString('base64'),
      })),
    },
    null,
    2,
  ) + '\n',
);
let child;
const parent = await main(output + '.devices.json', version, async (ctx) => {
  ctx.receipt.batchArchiveCleanup = true;
  child = {
    task: 'QA-09',
    scope: 'OWN_TELEMETRY_REDELIVERY_WITH_SPECIFIC_CONSUMPTION',
    prefix: ctx.receipt.prefix,
    sourceCommit: ctx.receipt.sourceCommit,
    startedAt: new Date().toISOString(),
    performance: {},
    fullQa09Accepted: false,
    sharedResourcesChanged: false,
    gate: 'RUNNING',
  };
  const id = ctx.receipt.devices[0],
    held = ctx.held.get(id);
  try {
    const payload = held.sim.payload('telemetry');
    payload.meta.seq = 50000;
    payload.data.feedingWeightKg = 4321;
    payload.audit.hash = computeAuditHash(payload);
    const raw = JSON.stringify(payload);
    await withFreshOwnMqttSession(ctx, (client) =>
      client.publishAsync('bnx/device/' + id + '/telemetry', raw, { qos: 1 }),
    );
    ctx.receipt.published.push({
      deviceId: id,
      type: 'telemetry',
      seq: payload.meta.seq,
      messageId: payload.meta.id,
      bodySha256: hash(raw),
    });
    let visible = false;
    for (let n = 0; n < 60; n++) {
      const value = await ctx.api('redelivery-visible-' + n, 'GET', '/api/v1/admin/devices/' + id + '/console', 200);
      if (value.data.metrics.metrics.feedingWeightKg?.max === 4321) {
        visible = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!visible) throw Error('ORIGINAL_MESSAGE_NOT_API_VISIBLE');
    child.performance.queueRedelivery = await redeliverOwnProcessedTelemetry(ctx, raw, output + '.submission.json');
    child.gate = child.performance.queueRedelivery.gate === 'BLOCKED' ? 'BLOCKED' : 'SUBMITTED_CONSUMPTION_NOT_PROVEN';
  } catch (e) {
    child.gate = 'FAIL';
    child.failureCode = e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'REDELIVERY_TARGET_FAILED');
  }
  child.superExports = queueOnly
    ? { gate: 'NOT_RUN_SEPARATE_PREVIOUS_RECEIPT' }
    : await runOwnSuperExports(ctx, output + '.super-exports.json');
  if (!queueOnly && child.superExports.gate !== 'PASS') child.gate = 'FAIL';
  child.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(child, null, 2) + '\n');
});
if (!child) {
  writeFileSync(
    output + '.gate.json',
    JSON.stringify(
      {
        task: 'QA-09',
        scope: 'PARENT_FAILED_BEFORE_QUEUE_EXTENSION',
        gate: 'FAIL',
        prefix: parent.prefix,
        sourceCommit: parent.sourceCommit,
        fullQa09Accepted: false,
        queueSubmissionGate: 'NOT_RUN',
        cleanup: 'SEE_PARENT_AND_UNKNOWN_COMMIT_RECOVERY',
        parentReceiptSha256: hash(readFileSync(output + '.devices.json')),
      },
      null,
      2,
    ) + '\n',
  );
  throw Error('PARENT_WAVE_FAILED_NO_SUBMISSION');
}
const domain = parent.cleanup.every((x) => x.result === 'PASS')
  ? await cleanupOwnedDomain(output + '.devices.json', output + '.domain-cleanup.json')
  : { gate: 'FAIL' };
let metadata;
try {
  metadata = await collectDataPathEvidence(output, version, output + '.data-path.json');
} catch (e) {
  metadata = {
    queueConsumptionGate: 'NO_RECEIPT_READ_BLOCKED',
    errorName: /^[A-Za-z0-9_]{1,80}$/.test(e.name ?? '') ? e.name : 'READ_FAILED',
  };
  writeFileSync(output + '.data-path-read-failure.json', JSON.stringify(metadata, null, 2) + '\n');
}
const gate = {
  task: 'QA-09',
  scope: child.scope,
  prefix: child.prefix,
  sourceCommit: child.sourceCommit,
  fullQa09Accepted: false,
  queueSubmissionGate: child.gate,
  queueConsumptionGate: metadata.queueConsumptionGate,
  superExportsGate: child.superExports?.gate,
  cleanup:
    parent.gate === 'PASS' &&
    domain.gate === 'PASS' &&
    (queueOnly ||
      (child.superExports?.cleanup.some((x) => x.type === 'database-and-outside-fingerprints' && x.result === 'PASS') &&
        !child.superExports?.cleanupFailure))
      ? 'PASS'
      : 'FAIL',
  parentReceiptSha256: hash(readFileSync(output + '.devices.json')),
};
gate.gate =
  gate.cleanup !== 'PASS'
    ? 'FAIL'
    : child.gate === 'FAIL'
      ? 'FAIL'
      : metadata.queueConsumptionGate === 'PASS_SPECIFIC_SQS_REDELIVERY_COMPLETED'
        ? 'PASS'
        : child.gate === 'BLOCKED'
          ? 'BLOCKED'
          : 'NO_RECEIPT';
writeFileSync(output + '.gate.json', JSON.stringify(gate, null, 2) + '\n');
console.log(JSON.stringify(gate));
process.exitCode = gate.gate === 'PASS' ? 0 : 1;
