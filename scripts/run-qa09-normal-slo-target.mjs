import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { runPerformanceProbes } from './qa09-performance-probes.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [output, version] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const paths = [
  'scripts/run-qa09-normal-slo-target.mjs',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-performance-probes.mjs',
  'scripts/qa09-own-queue-redelivery.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-archive-reader.mjs',
  'scripts/qa09-archive-probe.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'scripts/device-simulator/core.mjs',
  'contracts/mqtt/payload-normalization.ts',
  'apps/admin-web/src/auth/auth-flow.ts',
  'apps/admin-web/src/auth/cognito-idp.ts',
  'pnpm-lock.yaml',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      frozenAt: new Date().toISOString(),
      nodeVersion: process.version,
      versionReceiptSha256: sha(readFileSync(version)),
      sources: paths.map((path) => ({
        path,
        sha256: sha(readFileSync(path)),
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
    scope: 'NORMAL_WINDOW_SLO_WITHOUT_PRECEDING_QUICK_MQTT_BURST',
    prefix: ctx.receipt.prefix,
    sourceCommit: ctx.receipt.sourceCommit,
    startedAt: new Date().toISOString(),
    checks: [],
    requests: [],
    databaseBuilds: [],
    cleanup: [],
    gate: 'RUNNING',
    fullQa09Accepted: false,
    actualApiRole: 'PlatformSuperAdmin',
    lifecycleActiveDatabaseSeed: false,
  };
  const save = () => writeFileSync(output + '.probes.json', JSON.stringify(child, null, 2) + '\n');
  const record = (id, ok, data = {}) => {
    child.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
  };
  const demand = (id, ok, data = {}) => {
    record(id, ok, data);
    if (!ok) throw Error('NORMAL_SLO_PRECONDITION_FAILED');
  };
  const db = async (action, extra = {}) => {
    const path = output + '.' + action + '-' + child.databaseBuilds.length + '.json';
    const v = await runFixture(
      {
        prefix: ctx.receipt.prefix,
        devices: ctx.receipt.devices,
        customers: ctx.receipt.customers,
        action,
        baseline: ctx.baseline,
        ...extra,
      },
      path,
      console.log,
    );
    child.databaseBuilds.push({ action, receipt: path, buildId: v.build.id });
    save();
    return v.result;
  };
  const api = async (id, requestedRole, method, path, expected, body, headers) => {
    const started = performance.now();
    const data = await ctx.api(id, method, path, expected, body, headers);
    child.requests.push({
      id,
      requestedRole,
      actualRole: 'PlatformSuperAdmin',
      method,
      path,
      expected,
      requestId: data?.meta?.requestId ?? data?.error?.requestId,
      latencyMs: Math.round(performance.now() - started),
    });
    save();
    return data;
  };
  let baseline, site;
  try {
    baseline = (await db('business-baseline')).businessFingerprints;
    const current = await db('observe');
    demand(
      'normal-baseline-30-processed',
      current.receipts.length === 30 && current.receipts.every((x) => x.result === 'PROCESSED'),
    );
    demand(
      'normal-own-archives-drained',
      current.outbox.filter((x) => x.event_type === 'ARCHIVE').every((x) => x.status === 'PUBLISHED'),
    );
    child.normalWindowBeganAt = new Date().toISOString();
    save();
    site = (
      await ctx.api('normal-site-create', 'POST', '/api/v1/admin/sites', 201, {
        customerId: ctx.receipt.customers[0].id,
        name: ctx.receipt.prefix + '-normal-site-a',
        timezone: 'Asia/Shanghai',
      })
    ).data;
    child.site = { id: site.id, customerId: site.customerId, name: site.name };
    save();
    await ctx.api(
      'normal-device-assignment',
      'POST',
      '/api/v1/admin/devices/' + ctx.receipt.devices[0] + '/assignment',
      200,
      { customerId: site.customerId, siteId: site.id, reason: ctx.receipt.prefix },
    );
    child.performance = await runPerformanceProbes(ctx, api, record, output, { lifecycleProbes: false });
    const observed = await db('observe');
    demand(
      'normal-twenty-unique-telemetry-processed',
      ctx.receipt.published
        .filter((x) => x.seq >= 10000 && x.seq < 10020 && x.type === 'telemetry')
        .every(
          (p) =>
            observed.receipts.filter(
              (x) =>
                x.device_id === p.deviceId &&
                x.topic_type === 'telemetry' &&
                x.seq === p.seq &&
                x.result === 'PROCESSED',
            ).length === 1,
        ),
    );
    child.normalTelemetryUniqueRowsObserved = true;
    child.queueRedeliveryIdempotencyObserved = false;
    child.queueSpecificConsumptionProven = child.performance.queueRedelivery?.consumptionProven === true;
  } catch (e) {
    child.failureCode = /^[A-Z_]+$/.test(e.message) ? e.message : 'NORMAL_SLO_EXECUTION_FAILED';
    save();
  } finally {
    try {
      if (baseline) {
        const cleared = await db('business-cleanup', { businessBaseline: baseline });
        demand(
          'normal-business-cleanup-zero',
          Object.values(cleared.counts).every((x) => x === 0),
        );
        await db('business-audit', { businessBaseline: baseline });
        child.cleanup.push({ type: 'business-fixtures', result: 'PASS' });
      }
      if (site) {
        const path = '/api/v1/admin/sites/' + site.id;
        const found = await ctx.api('normal-site-cleanup-read', 'GET', path, 200);
        demand(
          'normal-site-owned',
          found.data.name === ctx.receipt.prefix + '-normal-site-a' &&
            found.data.customerId === ctx.receipt.customers[0].id,
        );
        await ctx.api('normal-site-delete', 'DELETE', path, 200, undefined, {
          'If-Match': String(found.data.version),
        });
        await ctx.api('normal-site-absent', 'GET', path, 404);
        child.cleanup.push({ type: 'site', id: site.id, result: 'PASS' });
      }
    } catch (e) {
      child.cleanup.push({ type: 'business-fixtures', result: 'FAIL' });
      child.cleanupFailure = /^[A-Z_]+$/.test(e.message) ? e.message : 'NORMAL_SLO_CLEANUP_FAILED';
    }
    child.finishedAt = new Date().toISOString();
    child.cleanupComplete = !!baseline && child.cleanup.every((x) => x.result === 'PASS');
    child.gate =
      !child.failureCode && child.checks.every((x) => x.result === 'PASS') && child.cleanupComplete
        ? 'PASS_SCOPED_NORMAL_WINDOW_SLO'
        : 'FAIL';
    save();
  }
  if (!child.cleanupComplete) throw Error('NORMAL_SLO_CLEANUP_FAILED');
});
let domainGate = 'NOT_RUN';
if (parent.cleanup.length && parent.cleanup.every((x) => x.result === 'PASS'))
  domainGate = (await cleanupOwnedDomain(output + '.devices.json', output + '.domain-cleanup.json')).gate;
const r = {
  task: 'QA-09',
  prefix: parent.prefix,
  sourceCommit: parent.sourceCommit,
  parentGate: parent.gate,
  sloGate: child?.gate,
  domainGate,
  fullQa09Accepted: false,
  gate:
    parent.gate === 'PASS' && child?.gate === 'PASS_SCOPED_NORMAL_WINDOW_SLO' && domainGate === 'PASS'
      ? 'PASS_SCOPED_NORMAL_WINDOW_SLO'
      : 'PARTIAL',
  finishedAt: new Date().toISOString(),
};
writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify(r));
process.exitCode = r.gate.startsWith('PASS') ? 0 : 1;
