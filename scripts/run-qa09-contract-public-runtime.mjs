import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateContractPublicBoundaries } from './qa09-contract-public-proof.mjs';
export const publicCases = [
  'off',
  'on',
  'pg-wait',
  'fields-cpu',
  'pg-reject',
  'validation-reject',
  'update-reject',
  'audit-reject',
];
const demand = (v, c) => {
  if (!v) throw Error(c);
};
export function summarizePublicCase(r) {
  demand(
    r.kind === 'qa09-runtime-public-seams/v1' &&
      r.gate === 'PASS' &&
      publicCases.includes(r.case) &&
      r.source === 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
    'PUBLIC_SOURCE',
  );
  demand(
    r.enabled === (r.case !== 'off') &&
      r.forcedYields === 0 &&
      r.native === false &&
      r.accountNative === true &&
      r.poolMax === 1 &&
      r.targetEquivalent === false &&
      r.compilerOnlyAttribution === false &&
      r.p95Accepted === false &&
      r.fullQa09Accepted === false &&
      r.auditReturnProjection === 'ID_ONLY_OFFLINE',
    'PUBLIC_SCOPE',
  );
  const fail = r.case.endsWith('reject'),
    n = fail ? 1 : 3,
    c = r.counts;
  demand(
    r.delayMs === (r.case === 'pg-wait' ? 30 : 0) && r.resultCpuMs === (r.case === 'fields-cpu' ? 20 : 0),
    'PUBLIC_CONTROL',
  );
  demand(
    r.samples.length === n &&
      c.pools === 1 &&
      c.network === 0 &&
      c.account === 1 &&
      c.checkout === n + 1 &&
      c.release === c.checkout &&
      c.dispose === 1 &&
      c.begin === n &&
      c.commit === (fail ? 0 : n) &&
      c.rollback === (fail ? 1 : 0) &&
      c.load === (r.case === 'validation-reject' ? 0 : n) &&
      c.update === (fail && !['update-reject', 'audit-reject'].includes(r.case) ? 0 : n) &&
      c.readback === (fail && r.case !== 'audit-reject' ? 0 : n) &&
      c.audit === (fail && r.case !== 'audit-reject' ? 0 : n),
    'PUBLIC_OWNERSHIP',
  );
  return r.samples.map((s, i) => {
    demand(
      s.index === i &&
        s.firstForClient === (i === 0) &&
        s.failed === fail &&
        (!fail || s.expectedFailureMatched === true),
      'PUBLIC_SEQUENCE',
    );
    const phases = s.observations.filter((p) => p.event === 'data-path.phase.completed'),
      own = s.observations.filter((p) => p.event === 'data-path.contract-load.ownership');
    demand(
      own.length === 1 &&
        own[0].modelEntries === 1 &&
        own[0].driverDispatches === (r.case === 'validation-reject' ? 0 : 1) &&
        own[0].transactional === (r.case !== 'validation-reject'),
      'PUBLIC_LOAD_OWNER',
    );
    demand(
      own[0].gatewayRequestId === `public-${r.case}-${i}` &&
        own[0].lambdaRequestId === `public-${r.case}-${i}` &&
        own[0].operationId === 'updateContract',
      'PUBLIC_TRACE_OWNER',
    );
    let proof = null;
    if (['pg-reject', 'validation-reject'].includes(r.case)) {
      let rejected = false;
      try {
        validateContractPublicBoundaries(phases, own, true);
      } catch {
        rejected = true;
      }
      demand(rejected, 'PUBLIC_FAILURE_MUST_REJECT');
    } else proof = validateContractPublicBoundaries(phases, own, r.enabled);
    demand(r.enabled || proof === null, 'PUBLIC_OFF');
    if (r.case === 'pg-wait')
      demand(
        proof.windowsMs['contract-load-pg-await'] >= 27 && proof.windowsMs['contract-load-driver-await'] >= 27,
        'PUBLIC_WAIT_LOCATION',
      );
    if (r.case === 'fields-cpu')
      demand(
        proof.windowsMs['contract-load-driver-await'] >= 17 &&
          phases.find((p) => p.phase === 'contract-load-driver-after-pg')?.durationMs >= 17,
        'PUBLIC_FIELDS_LOCATION',
      );

    demand(
      Object.values(s.windowsMs).every((v) => Number.isFinite(v) && v >= 0),
      'PUBLIC_WINDOWS',
    );
    if (!fail)
      demand(
        Object.keys(s.windowsMs).length === 4 && s.windowsMs.load >= r.delayMs + r.resultCpuMs - 3,
        'PUBLIC_CONTROL_COVERAGE',
      );
    return {
      index: i,
      firstForClient: s.firstForClient,
      gate: fail ? 'EXPECTED_FAILURE' : 'PASS',
      windowsMs: s.windowsMs,
      proof,
    };
  });
}
export function runPublicMatrix(directory) {
  const root = resolve(directory);
  demand(!existsSync(root), 'FRESH_MATRIX_DIRECTORY_REQUIRED');
  mkdirSync(root, { recursive: true });
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const inputs = [
    'scripts/run-qa09-contract-public-runtime.mjs',
    'scripts/qa09-contract-public-proof.mjs',
    'scripts/qa09-contract-load-detail-proof.mjs',
    'scripts/qa09-contract-load-proof.mjs',
    'packages/database/test/contract-public-runtime.test.ts',
    'packages/database/src/client.ts',
    'packages/database/src/client-preparation.ts',
    'packages/database/src/contract-load-pg-lease.ts',
    'packages/database/src/observed-pg.ts',
    'packages/database/src/contract-load-observation.ts',
    'packages/observability/src/data-path.ts',
    'apps/cloud-api/src/admin/contract/load-candidate.ts',
    'packages/database/prisma/schema.prisma',
    'pnpm-lock.yaml',
    'node_modules/@prisma/adapter-pg/dist/index.mjs',
  ].map((path) => ({ path, sha256: hash(readFileSync(path)) }));
  const rows = [];
  for (const name of publicCases) {
    const output = root + '/' + name + '.json',
      args = ['node_modules/vitest/vitest.mjs', 'run', 'packages/database/test/contract-public-runtime.test.ts'];
    writeFileSync(
      root + '/' + name + '.command.json',
      JSON.stringify({ command: [process.execPath, ...args], case: name, deadlineMs: 45000 }) + '\n',
    );
    const child = spawnSync(process.execPath, args, {
      env: { ...process.env, QA09_PUBLIC_CASE: name, QA09_PUBLIC_OUTPUT: output },
      timeout: 45000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(root + '/' + name + '.log', (child.stdout ?? '') + (child.stderr ?? ''));
    writeFileSync(root + '/' + name + '.exit', String(child.status ?? -1) + '\n');
    demand(child.status === 0, 'PUBLIC_CHILD_FAILED');
    const bytes = readFileSync(output),
      r = JSON.parse(bytes);
    rows.push({
      case: name,
      receipt: name + '.json',
      sha256: hash(bytes),
      counts: r.counts,
      samples: summarizePublicCase(r),
    });
  }
  const result = {
    gate: 'PASS',
    scope: 'OFFLINE_REAL_PRISMA_PUBLIC_SEAMS_NO_FORCED_YIELDS',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    budget: {
      childProcesses: 8,
      concurrency: 1,
      childDeadlineMs: 45000,
      poolMax: 1,
      networkRequests: 0,
      databaseServers: 0,
      targetFixtures: 0,
    },
    inputs,
    rows,
    afterQueueAttribution: 'UNRESOLVED_NO_STABLE_COMPILER_SEAM',
    targetEquivalent: false,
    compilerOnlyAttribution: false,
    serverExecutionIsolated: false,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
  writeFileSync(root + '/matrix.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length === 3, 'OUTPUT_DIRECTORY_REQUIRED');
  const r = runPublicMatrix(process.argv[2]);
  console.log(JSON.stringify({ gate: r.gate, cases: r.rows.length, networkRequests: 0 }));
}
