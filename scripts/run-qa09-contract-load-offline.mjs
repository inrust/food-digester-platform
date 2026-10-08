import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateContractLoadSplit } from './qa09-contract-load-proof.mjs';

export const offlineCases = Object.freeze([
  'orm-zero',
  'raw-zero',
  'orm-wait',
  'raw-wait',
  'orm-result',
  'raw-result',
  'raw-reject',
  'raw-invalid',
]);
const demand = (value, code) => {
  if (!value) throw Error(code);
};
/** Validate controlled public boundaries. Does not interpret wall time as compiler/server-only CPU. */
export function summarizeOfflineCase(receipt) {
  demand(
    receipt.gate === 'PASS' &&
      receipt.source === 'REAL_PRISMA_ADAPTER_CONTROLLED_PG_ONLY' &&
      offlineCases.includes(receipt.case),
    'OFFLINE_SOURCE',
  );
  demand(
    receipt.poolMax === 1 &&
      receipt.targetEquivalent === false &&
      receipt.compilerOnlyAttribution === false &&
      receipt.serverExecutionIsolated === false &&
      receipt.p95Accepted === false &&
      receipt.fullQa09Accepted === false,
    'OFFLINE_SCOPE',
  );
  const expectedFailure = ['raw-reject', 'raw-invalid'].includes(receipt.case);
  demand(
    receipt.accountRaw === receipt.case.startsWith('raw-') &&
      receipt.delayMs === (receipt.case.endsWith('-wait') ? 30 : 0) &&
      receipt.resultCpuMs === (receipt.case.endsWith('-result') ? 20 : 0) &&
      Number.isFinite(receipt.accountMs) &&
      receipt.accountMs >= 0,
    'OFFLINE_CONTROL_INPUT',
  );
  demand(receipt.samples.length === (expectedFailure ? 1 : 3), 'OFFLINE_SAMPLE_BUDGET');
  const count = receipt.counts;
  demand(
    count.account === 1 &&
      count.checkout === receipt.samples.length + 1 &&
      count.release === count.checkout &&
      count.dispose === 1 &&
      count.begin === receipt.samples.length &&
      count.commit === (expectedFailure ? 0 : 3) &&
      count.rollback === (expectedFailure ? 1 : 0) &&
      count.contract === (receipt.case === 'raw-invalid' ? 0 : expectedFailure ? 1 : 3),
    'OFFLINE_OWNERSHIP',
  );
  const boundaries = [
    'publicQueryEntered',
    'publicQueryReturned',
    'adapterEntered',
    'pgEntered',
    'resultReady',
    'fieldsRead',
    'fieldsReady',
    'adapterSettled',
  ];
  return receipt.samples.map((sample, index) => {
    demand(
      sample.index === index &&
        sample.firstContractForClient === (index === 0) &&
        sample.expectedFailure === expectedFailure &&
        sample.failure === expectedFailure,
      'OFFLINE_SEQUENCE',
    );
    const phases = sample.phases.filter((r) => r.event === 'data-path.phase.completed');
    const ownership = sample.phases.filter((r) => r.event === 'data-path.contract-load.ownership');
    if (expectedFailure) {
      demand(
        phases.some((p) => p.phase === 'contract-load' && p.outcome === 'FAIL') &&
          ownership.length === 1 &&
          ownership[0].driverDispatches === (receipt.case === 'raw-invalid' ? 0 : 1),
        'OFFLINE_FAILURE_PROOF',
      );
      return { index, gate: 'EXPECTED_FAILURE', rollback: true, retried: false };
    }
    const originalSplit = validateContractLoadSplit(phases, ownership, true);
    const m = sample.marks;
    demand(
      boundaries.every((key, i) => Number.isFinite(m[key]) && m[key] >= 0 && (!i || m[key] >= m[boundaries[i - 1]])),
      'OFFLINE_BOUNDARY_ORDER',
    );
    const ms = (a, b) => Math.round((m[b] - m[a]) * 1000) / 1000;
    const durations = {
      publicQueryCallMs: ms('publicQueryEntered', 'publicQueryReturned'),
      returnToAdapterMs: ms('publicQueryReturned', 'adapterEntered'),
      adapterToPgMs: ms('adapterEntered', 'pgEntered'),
      controlledPgMs: ms('pgEntered', 'resultReady'),
      resultReadyToFieldsMs: ms('resultReady', 'fieldsRead'),
      controlledFieldsCpuMs: ms('fieldsRead', 'fieldsReady'),
      fieldsReadyToAdapterMs: ms('fieldsReady', 'adapterSettled'),
      adapterTotalMs: ms('adapterEntered', 'adapterSettled'),
    };
    const sum = Object.entries(durations)
      .filter(([key]) => !['publicQueryCallMs', 'returnToAdapterMs', 'adapterTotalMs'].includes(key))
      .reduce((total, [, n]) => total + n, 0);
    demand(Math.abs(sum - durations.adapterTotalMs) <= 0.01, 'OFFLINE_DRIVER_COVERAGE');
    demand(
      durations.controlledPgMs >= receipt.delayMs - 2 && durations.controlledFieldsCpuMs >= receipt.resultCpuMs - 1,
      'OFFLINE_INJECTION_COVERAGE',
    );
    return {
      index,
      gate: 'PASS',
      firstContractForClient: index === 0,
      originalSplit,
      durations,
      publicWindowOnly: true,
    };
  });
}

export function runOfflineMatrix(directory) {
  const root = resolve(directory);
  demand(!existsSync(root + '/matrix.json'), 'NO_RECEIPT_OVERWRITE');
  mkdirSync(root, { recursive: true });
  const inputs = [
    'scripts/run-qa09-contract-load-offline.mjs',
    'scripts/qa09-contract-load-proof.mjs',
    'packages/database/test/contract-load-offline.test.ts',
    'packages/database/src/client.ts',
    'packages/database/src/observed-pg.ts',
    'packages/database/src/contract-load-observation.ts',
    'apps/cloud-api/src/admin/user/account-read-candidate.ts',
    'apps/cloud-api/src/admin/contract/service.ts',
    'packages/database/prisma/schema.prisma',
    'pnpm-lock.yaml',
    'node_modules/@prisma/adapter-pg/dist/index.mjs',
  ].map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  const rows = [];
  for (const name of offlineCases) {
    const output = root + '/' + name + '.json';
    demand(!existsSync(output) && !existsSync(root + '/' + name + '.log'), 'NO_CASE_REPLAY');
    const args = ['node_modules/vitest/vitest.mjs', 'run', 'packages/database/test/contract-load-offline.test.ts'];
    writeFileSync(
      root + '/' + name + '.command.json',
      JSON.stringify({ command: [process.execPath, ...args], case: name, deadlineMs: 45000 }) + '\n',
    );
    const child = spawnSync(process.execPath, args, {
      env: { ...process.env, QA09_OFFLINE_CASE: name, QA09_OFFLINE_OUTPUT: output },
      timeout: 45000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(root + '/' + name + '.log', (child.stdout ?? '') + (child.stderr ?? ''));
    writeFileSync(root + '/' + name + '.exit', String(child.status ?? -1) + '\n');
    demand(child.status === 0, 'OFFLINE_CHILD_FAILED');
    const bytes = readFileSync(output),
      receipt = JSON.parse(bytes);
    rows.push({
      case: name,
      receipt: name + '.json',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      accountMs: receipt.accountMs,
      samples: summarizeOfflineCase(receipt),
    });
  }
  const result = {
    gate: 'PASS',
    scope: 'OFFLINE_PUBLIC_BOUNDARIES_OWNERSHIP_AND_CONTROLLED_FAILURE_MATRIX',
    source: 'FRESH_NODE_PROCESS_PER_CASE_REAL_PRISMA_CONTROLLED_PG',
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
    targetEquivalent: false,
    modelCostShift: 'NOT_ESTABLISHED',
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
  const result = runOfflineMatrix(process.argv[2]);
  console.log(JSON.stringify({ gate: result.gate, cases: result.rows.length, networkRequests: 0 }));
}
