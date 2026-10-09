import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateContractAwaitCheckpoint } from './qa09-contract-load-detail-proof.mjs';
export const awaitCases = [
  'orm-zero',
  'native-zero',
  'orm-wait',
  'native-wait',
  'orm-result',
  'native-result',
  'orm-reject',
  'native-reject',
  'native-invalid',
  'native-update-reject',
  'native-audit-reject',
];
const demand = (v, code) => {
  if (!v) throw Error(code);
};
export function summarizeAwaitCase(r) {
  demand(
    r.gate === 'PASS' && r.source === 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK' && awaitCases.includes(r.case),
    'AWAIT_SOURCE',
  );
  demand(
    r.native === r.case.startsWith('native-') &&
      r.accountNative === true &&
      r.poolMax === 1 &&
      r.targetEquivalent === false &&
      r.compilerOnlyAttribution === false &&
      r.p95Accepted === false &&
      r.fullQa09Accepted === false &&
      r.auditReturnProjection === 'ID_ONLY_OFFLINE',
    'AWAIT_SCOPE',
  );
  demand(
    r.delayMs === (r.case.endsWith('-wait') ? 30 : 0) && r.resultCpuMs === (r.case.endsWith('-result') ? 20 : 0),
    'AWAIT_CONTROL',
  );
  const fail = r.case.includes('reject') || r.case.endsWith('invalid'),
    n = fail ? 1 : 3,
    c = r.counts;
  demand(
    r.samples.length === n &&
      c.account === 1 &&
      c.checkout === n + 1 &&
      c.release === c.checkout &&
      c.dispose === 1 &&
      c.begin === n &&
      c.commit === (fail ? 0 : n) &&
      c.rollback === (fail ? 1 : 0) &&
      c.load === n &&
      c.update === (fail && !['native-update-reject', 'native-audit-reject'].includes(r.case) ? 0 : n) &&
      c.readback === (fail && r.case !== 'native-audit-reject' ? 0 : n) &&
      c.audit === (fail && r.case !== 'native-audit-reject' ? 0 : n),
    'AWAIT_OWNERSHIP',
  );
  return r.samples.map((s, i) => {
    demand(s.index === i && s.firstForClient === (i === 0) && s.failed === fail, 'AWAIT_SEQUENCE');
    demand(
      Object.entries(s.windowsMs).every(
        ([k, v]) => ['load', 'update', 'readback', 'audit'].includes(k) && Number.isFinite(v) && v >= 0,
      ),
      'AWAIT_WINDOWS',
    );
    const phases = s.observations.filter((p) => p.event === 'data-path.phase.completed'),
      own = s.observations.filter((p) => p.event === 'data-path.contract-load.ownership');
    demand(
      own.length === 1 &&
        own[0].driverDispatches === 1 &&
        own[0].transactional === true &&
        own[0].modelEntries === (r.native ? 0 : 1),
      'AWAIT_LOAD_OWNER',
    );
    const checkpoint = !r.native && !fail ? validateContractAwaitCheckpoint(phases, own, true) : null;
    if (r.native)
      demand(!phases.some((p) => p.phase === 'contract-load-orm-prepare'), 'NATIVE_MUST_NOT_IMPERSONATE_MODEL');
    if (!fail)
      demand(
        s.windowsMs.load >= r.delayMs + r.resultCpuMs - 3 && Object.keys(s.windowsMs).length === 4,
        'AWAIT_CONTROL_COVERAGE',
      );
    return {
      index: i,
      firstForClient: s.firstForClient,
      gate: fail ? 'EXPECTED_FAILURE' : 'PASS',
      windowsMs: s.windowsMs,
      checkpoint,
    };
  });
}
export function runAwaitMatrix(directory) {
  const root = resolve(directory);
  demand(!existsSync(root + '/matrix.json'), 'NO_MATRIX_OVERWRITE');
  mkdirSync(root, { recursive: true });
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const inputs = [
    'scripts/run-qa09-contract-await-offline.mjs',
    'scripts/qa09-contract-load-detail-proof.mjs',
    'packages/database/test/contract-await-offline.test.ts',
    'apps/cloud-api/src/admin/contract/load-candidate.ts',
    'apps/cloud-api/src/admin/contract/service.ts',
    'packages/database/src/client.ts',
    'packages/database/src/observed-pg.ts',
    'packages/database/src/contract-load-observation.ts',
    'packages/observability/src/data-path.ts',
    'packages/database/prisma/schema.prisma',
    'pnpm-lock.yaml',
    'node_modules/@prisma/adapter-pg/dist/index.mjs',
  ].map((path) => ({ path, sha256: hash(readFileSync(path)) }));
  const rows = [];
  for (const name of awaitCases) {
    const output = root + '/' + name + '.json',
      log = root + '/' + name + '.log';
    demand(!existsSync(output) && !existsSync(log), 'NO_CASE_REPLAY');
    const args = ['node_modules/vitest/vitest.mjs', 'run', 'packages/database/test/contract-await-offline.test.ts'];
    writeFileSync(
      root + '/' + name + '.command.json',
      JSON.stringify({ command: [process.execPath, ...args], case: name, deadlineMs: 45000 }) + '\n',
    );
    const child = spawnSync(process.execPath, args, {
      env: { ...process.env, QA09_AWAIT_CASE: name, QA09_AWAIT_OUTPUT: output },
      timeout: 45000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(log, (child.stdout ?? '') + (child.stderr ?? ''));
    writeFileSync(root + '/' + name + '.exit', String(child.status ?? -1) + '\n');
    demand(child.status === 0, 'AWAIT_CHILD_FAILED');
    const bytes = readFileSync(output),
      receipt = JSON.parse(bytes);
    rows.push({ case: name, receipt: name + '.json', sha256: hash(bytes), samples: summarizeAwaitCase(receipt) });
  }
  const result = {
    gate: 'PASS',
    scope: 'OFFLINE_MICROTASK_BOUNDARIES_REPLACEMENT_READ_AND_DOWNSTREAM_COST',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    budget: {
      childProcesses: 11,
      concurrency: 1,
      childDeadlineMs: 45000,
      poolMax: 1,
      networkRequests: 0,
      databaseServers: 0,
      targetFixtures: 0,
    },
    inputs,
    rows,
    targetEquivalent: false,
    modelCostShift: 'OBSERVATIONS_ONLY_NOT_TARGET_CAUSALITY',
    compilerOnlyAttribution: false,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
  writeFileSync(root + '/matrix.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length === 3, 'OUTPUT_DIRECTORY_REQUIRED');
  const r = runAwaitMatrix(process.argv[2]);
  console.log(JSON.stringify({ gate: r.gate, cases: r.rows.length, networkRequests: 0 }));
}
