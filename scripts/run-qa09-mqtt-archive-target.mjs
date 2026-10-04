import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { runMqttQuickTarget } from './qa09-mqtt-load-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';

const [output, version] = process.argv.slice(2);
if (!output || !version) throw Error('OUTPUT_AND_VERSION_REQUIRED');
const paths = [
  'scripts/run-qa09-mqtt-archive-target.mjs',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-mqtt-load-target.mjs',
  'scripts/qa09-publish-scheduler.mjs',
  'scripts/reliability-plan.mjs',
  'scripts/qa09-version-inputs.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-db-readonly-probe.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/prepare-qa09-db-readonly-probe.mjs',
  'scripts/qa09-archive-reader.mjs',
  'scripts/qa09-archive-probe.mjs',
  'scripts/qa09-own-s3-cli.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'scripts/device-simulator/core.mjs',
  'infra/environments/qa09-current-test.json',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      scope: 'EXECUTED_SOURCE_BYTES_MQTT_ARCHIVE_ONLY',
      frozenAt: new Date().toISOString(),
      nodeVersion: process.version,
      sources: paths.map((path) => {
        const bytes = readFileSync(path);
        return {
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sourceBase64: bytes.toString('base64'),
        };
      }),
    },
    null,
    2,
  ) + '\n',
);
let r;
const parent = await main(output + '.devices.json', version, async (ctx) => {
  r = {
    task: 'QA-09',
    scope: 'REAL_MQTT_QUICK_AND_COMPLETE_ARCHIVE_DEADLINE',
    prefix: ctx.receipt.prefix,
    sourceCommit: ctx.receipt.sourceCommit,
    startedAt: new Date().toISOString(),
    checks: [],
    databaseBuilds: [],
    gate: 'RUNNING',
    fullQa09Accepted: false,
    commandAndTelemetryP95Claimed: false,
    roleMatrixClaimed: false,
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  const record = (id, ok, data = {}) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
  };
  const db = async (action) => {
    const path = output + '.' + action + '-' + r.databaseBuilds.length + '.json';
    const value = await runFixture(
      {
        prefix: r.prefix,
        devices: ctx.receipt.devices,
        customers: ctx.receipt.customers,
        action,
        baseline: ctx.baseline,
      },
      path,
      console.log,
    );
    r.databaseBuilds.push({ action, receipt: path, buildId: value.build.id });
    save();
    return value.result;
  };
  ctx.receipt.batchArchiveCleanup = true;
  delete ctx.receipt.archiveKeys;
  save();
  try {
    r.result = await runMqttQuickTarget(ctx, db, record, output);
  } catch (error) {
    r.failure = {
      errorName: /^[A-Za-z0-9_]+$/.test(error.name ?? '') ? error.name : 'Error',
      code: /^[A-Z_]+$/.test(error.message ?? '') ? error.message : 'MQTT_ARCHIVE_EXECUTION_FAILED',
    };
  } finally {
    r.finishedAt = new Date().toISOString();
    r.gate = !r.failure && r.result && r.checks.length && r.checks.every((x) => x.result === 'PASS') ? 'PASS' : 'FAIL';
    save();
  }
});
let domainGate = 'NOT_RUN';
if (parent.finishedAt && parent.cleanup.length && parent.cleanup.every((x) => x.result === 'PASS')) {
  const domain = await cleanupOwnedDomain(output + '.devices.json', output + '.domain-cleanup.json');
  domainGate = domain.gate;
}
console.log(
  JSON.stringify({
    gate: r?.gate === 'PASS' && parent.gate === 'PASS' && domainGate === 'PASS' ? 'PASS' : 'FAIL',
    prefix: parent.prefix,
    mqttArchiveGate: r?.gate ?? 'NOT_RUN',
    parentGate: parent.gate,
    domainCleanupGate: domainGate,
    fullQa09Accepted: false,
  }),
);
process.exitCode = r?.gate === 'PASS' && parent.gate === 'PASS' && domainGate === 'PASS' ? 0 : 1;
