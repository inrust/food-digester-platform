import { runMqttQuickTarget } from './qa09-mqtt-load-target.mjs';
import { runDeviceConfirmationProbes } from './qa09-device-confirmation-probes.mjs';
import { runAuthRepro } from './qa09-auth-repro.mjs';
import { runOnlineBrowserGuards } from './qa09-online-browser-guards.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { runPerformanceProbes } from './qa09-performance-probes.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [output, version] = process.argv.slice(2);
if (!output || !version) throw Error('OUTPUT_AND_VERSION_REQUIRED');
const commandOnly = process.env.QA09_COMMAND_ONLY === 'true';
const paths = [
  'scripts/run-qa09-slo-target.mjs',
  'scripts/qa09-mqtt-load-target.mjs',
  'scripts/qa09-publish-scheduler.mjs',
  'scripts/reliability-plan.mjs',
  'scripts/qa09-performance-probes.mjs',
  'scripts/qa09-own-queue-redelivery.mjs',
  'scripts/qa09-online-browser-guards.mjs',
  'scripts/qa09-auth-repro.mjs',
  'scripts/qa09-device-confirmation-probes.mjs',
  'scripts/qa09-write-boundary-probes.mjs',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-version-inputs.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-own-s3-cli.mjs',
  'scripts/qa09-archive-reader.mjs',
  'scripts/qa09-archive-probe.mjs',
  'scripts/device-simulator/core.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'infra/environments/qa09-current-test.json',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      scope: 'EXECUTED_SOURCE_BYTES',
      frozenAt: new Date().toISOString(),
      nodeVersion: process.version,
      commandOnly,
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
    scope: 'REAL_SLO_LIFECYCLE_WITH_ONLINE_KEEPALIVE',
    actorRole: 'PlatformSuperAdmin',
    roleMatrixClaimed: false,
    prefix: ctx.receipt.prefix,
    sourceCommit: ctx.receipt.sourceCommit,
    startedAt: new Date().toISOString(),
    checks: [],
    databaseBuilds: [],
    cleanup: [],
    createdSites: [],
    gate: 'RUNNING',
    fullQa09Accepted: false,
    commandOnly,
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  const record = (id, ok, data = {}) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
  };
  const api = (id, _role, method, path, expected, body, headers) => ctx.api(id, method, path, expected, body, headers);
  const db = async (action, businessBaseline) => {
    const path = output + '.' + action + '.json';
    const v = await runFixture(
      {
        prefix: r.prefix,
        devices: ctx.receipt.devices,
        customers: ctx.receipt.customers,
        action,
        baseline: ctx.baseline,
        ...(businessBaseline ? { businessBaseline } : {}),
      },
      path,
      console.log,
    );
    r.databaseBuilds.push({ action, receipt: path, buildId: v.build.id });
    save();
    return v.result;
  };
  let baseline;
  try {
    baseline = (await db('business-baseline')).businessFingerprints;
    r.authRepro = await runAuthRepro(ctx, output + '.auth-repro.json');
    record('auth-signature-denial-repro', r.authRepro.denialGate === 'PASS');
    record(
      'auth-repro-identities-cleaned',
      r.authRepro.cleanup.length === 2 && r.authRepro.cleanup.every((x) => x.result === 'PASS'),
    );

    const site = (
      await api('slo-site-create', 'PlatformSuperAdmin', 'POST', '/api/v1/admin/sites', 201, {
        customerId: ctx.receipt.customers[0].id,
        name: r.prefix + '-slo-site',
        timezone: 'Asia/Shanghai',
      })
    ).data;
    r.createdSites.push({ id: site.id, customerId: site.customerId });
    save();
    await api(
      'slo-own-device-assignment',
      'PlatformSuperAdmin',
      'POST',
      '/api/v1/admin/devices/' + ctx.receipt.devices[0] + '/assignment',
      200,
      { customerId: ctx.receipt.customers[0].id, siteId: site.id, reason: r.prefix },
    );
    ctx.receipt.batchArchiveCleanup = true;
    delete ctx.receipt.archiveKeys;
    if (process.env.QA09_RUN_MQTT_QUICK === 'true') {
      try {
        r.mqttQuick = await runMqttQuickTarget(ctx, db, record, output);
        record('mqtt-quick-load-completed', true);
      } catch (error) {
        r.mqttQuickFailure = {
          errorName: error.name,
          code: /^[A-Z_]+$/.test(error.message ?? '') ? error.message : 'MQTT_QUICK_FAILED',
        };
        record('mqtt-quick-load-completed', false);
      }
    }
    r.result = await runPerformanceProbes(ctx, api, record, output, {
      commandOnly,
      afterActivation: async () => {
        r.lifecycleFixture = await db('business-seed-active-lifecycle');
        r.naturalLifecycleGate = 'BLOCKED_ASSIGNED_TO_LICENSED_TO_ACTIVE_RUNTIME_PATH_MISSING';
        if (commandOnly) return;
        r.deviceConfirmation = await runDeviceConfirmationProbes(
          ctx,
          api,
          record,
          output + '.device-confirmation.json',
        );
        record('device-confirmation-lifecycle', r.deviceConfirmation.gate === 'PASS');
        r.browser = await runOnlineBrowserGuards(ctx, output + '.online-browser.json');
        record('entitled-device-browser-guards', r.browser.gate === 'PASS');
      },
    });
  } catch (e) {
    r.failure = { code: e.code ?? 'SLO_EXECUTOR_FAILED', errorName: e.name, causeCode: e.cause?.code };
  } finally {
    if (baseline)
      try {
        await ctx.refreshIdentity();
        const cleanup = await db('business-cleanup', baseline);
        record(
          'slo-exact-business-cleanup',
          Object.values(cleanup.counts).every((n) => n === 0),
        );
        const audit = await db('business-audit', baseline);
        record('slo-outside-scope-unchanged', JSON.stringify(audit.businessFingerprints) === JSON.stringify(baseline));
        r.cleanup.push({ scope: 'business-fixtures', result: 'PASS' });
      } catch (e) {
        r.cleanup.push({ scope: 'business-fixtures', result: 'FAIL', errorName: e.name, code: e.code ?? e.message });
      }
    for (const site of r.createdSites)
      try {
        const path = '/api/v1/admin/sites/' + site.id;
        const current = await api('slo-cleanup-site-read', 'PlatformSuperAdmin', 'GET', path, 200);
        await api('slo-cleanup-site-delete', 'PlatformSuperAdmin', 'DELETE', path, 200, undefined, {
          'If-Match': String(current.data.version),
        });
        await api('slo-cleanup-site-absent', 'PlatformSuperAdmin', 'GET', path, 404);
        r.cleanup.push({ scope: 'site', id: site.id, result: 'PASS' });
      } catch (e) {
        r.cleanup.push({ scope: 'site', id: site.id, result: 'FAIL', errorName: e.name });
      }
    r.finishedAt = new Date().toISOString();
    r.gate =
      !r.failure &&
      r.checks.length &&
      r.checks.every((x) => x.result === 'PASS') &&
      r.cleanup.length &&
      r.cleanup.every((x) => x.result === 'PASS')
        ? 'PASS'
        : 'FAIL';
    save();
  }
  if (r.cleanup.some((x) => x.result !== 'PASS')) throw Error('SLO_BUSINESS_CLEANUP_FAILED');
});
if (parent.gate === 'PASS' && parent.cleanup.every((x) => x.result === 'PASS'))
  await cleanupOwnedDomain(output + '.devices.json', output + '.domain-cleanup.json');
process.exitCode = r?.gate === 'PASS' && parent.gate === 'PASS' ? 0 : 1;
