import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { runBusinessTarget } from './qa09-business-target.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
import { confirmOwnLicenseReceived, licenseSyncObservationGate } from './qa09-natural-lifecycle-observation.mjs';

const [output, version] = process.argv.slice(2);
if (!output || !version) throw Error('OUTPUT_AND_VERSION_REQUIRED');
const paths = [
  'scripts/run-qa09-continuation-wave.mjs',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-business-target.mjs',
  'scripts/qa09-license-lifecycle.mjs',
  'scripts/qa09-natural-lifecycle-observation.mjs',
  'scripts/qa09-data-path-evidence.mjs',
  'scripts/qa09-write-boundary-probes.mjs',
  'scripts/qa09-performance-probes.mjs',
  'scripts/qa09-own-queue-redelivery.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-readonly-probe.mjs',
  'scripts/prepare-qa09-db-readonly-probe.mjs',
  'scripts/qa09-mqtt-load-target.mjs',
  'scripts/qa09-publish-scheduler.mjs',
  'scripts/reliability-plan.mjs',
  'scripts/qa09-archive-reader.mjs',
  'scripts/qa09-archive-probe.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'scripts/qa09-own-s3-cli.mjs',
  'scripts/qa09-current-environment.mjs',
  'infra/environments/qa09-current-test.json',
  'scripts/device-simulator/core.mjs',
  'contracts/mqtt/payload-normalization.ts',
  'apps/cloud-api/src/runtime/delivered-operations.ts',
  'apps/admin-web/src/auth/auth-flow.ts',
  'apps/admin-web/src/auth/cognito-idp.ts',
  'package.json',
  'pnpm-lock.yaml',
  '.nvmrc',
  'scripts/qa09-version-inputs.mjs',
  'apps/admin-web/src/router/routes.ts',
  'packages/auth/src/permissions.ts',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      frozenAt: new Date().toISOString(),
      nodeVersion: process.version,
      applicationVersionReceiptSha256: createHash('sha256').update(readFileSync(version)).digest('hex'),
      scope: 'REAL_BUSINESS_SECURITY_BROWSER_RELIABILITY_AND_NATURAL_LIFECYCLE_OBSERVATION',
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
let natural;
const parent = await main(output + '.devices.json', version, async (ctx) => {
  natural = {
    prefix: ctx.receipt.prefix,
    sourceCommit: ctx.receipt.sourceCommit,
    rows: [],
    scope: 'NATURAL_LICENSE_SYNC_OBSERVATION_NO_ACTIVE_DATABASE_SEED',
    fullQa09Accepted: false,
  };
  const observe = (phase) => async (license) => {
    try {
      const row = await confirmOwnLicenseReceived(ctx, license.licenseId, natural.rows.at(-1)?.snapshotAt ?? null);
      const detail = await ctx.api(
        'natural-' + phase + '-device-readback',
        'GET',
        '/api/v1/admin/devices/' + ctx.receipt.devices[0],
        200,
      );
      natural.rows.push({ phase, ...row, adminLifecycleStatus: detail.data.lifecycleStatus });
    } catch (error) {
      natural.rows.push({
        phase,
        status: 0,
        errorCode: /^[A-Z_]+$/.test(error.message) ? error.message : 'NATURAL_OBSERVATION_FAILED',
      });
    }
    Object.assign(natural, licenseSyncObservationGate(natural.rows));
    writeFileSync(output + '.natural-lifecycle.json', JSON.stringify(natural, null, 2) + '\n');
  };
  await runBusinessTarget(ctx, output + '.business.json', {
    onLicenseIssued: observe('issued'),
    onLicenseActivated: observe('activated'),
    performanceProbes: true,
    performanceLifecycleProbes: false,
    writeBoundaryProbes: true,
  });
});
let domainGate = 'NOT_RUN';
if (parent.finishedAt && parent.cleanup.length && parent.cleanup.every((r) => r.result === 'PASS'))
  domainGate = (await cleanupOwnedDomain(output + '.devices.json', output + '.domain-cleanup.json')).gate;
const business = (() => {
  try {
    return JSON.parse(readFileSync(output + '.business.json'));
  } catch {
    return null;
  }
})();
const result = {
  prefix: parent.prefix,
  sourceCommit: parent.sourceCommit,
  applicationVersionReceiptSha256: createHash('sha256').update(readFileSync(version)).digest('hex'),
  executorSourcesReceiptSha256: createHash('sha256')
    .update(readFileSync(output + '.sources.json'))
    .digest('hex'),
  parentGate: parent.gate,
  businessGate: business?.gate ?? 'NOT_RUN',
  stages: business?.stages ?? {},
  naturalLifecycleGate: natural?.naturalLifecycleGate ?? 'NOT_RUN',
  domainCleanupGate: domainGate,
  fullQa09Accepted: false,
  finishedAt: new Date().toISOString(),
  gate: 'PARTIAL',
  kmsAndIamManagementPerformed: false,
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
process.exitCode = parent.gate === 'PASS' && business?.gate === 'PASS' && domainGate === 'PASS' ? 0 : 1;
