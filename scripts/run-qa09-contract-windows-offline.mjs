import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowCases, summarizeContractWindows } from './qa09-contract-windows-proof.mjs';
export function runContractWindows(directory) {
  const root = resolve(directory),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  // A failed/partial run is evidence too. Never reuse even an empty existing directory.
  if (existsSync(root)) throw Error('FRESH_DIRECTORY_REQUIRED');
  mkdirSync(root, { recursive: true });
  const inputs = [
    'scripts/run-qa09-contract-windows-offline.mjs',
    'scripts/qa09-contract-windows-proof.mjs',
    'packages/database/test/contract-windows-offline.test.ts',
    'packages/database/test/helpers/contract-window-probe.ts',
    'packages/database/src/client.ts',
    'packages/database/src/observed-pg.ts',
    'packages/database/src/contract-load-observation.ts',
    'packages/database/src/contract-load-pg-lease.ts',
    'packages/observability/src/data-path.ts',
    'packages/database/prisma/schema.prisma',
    'apps/cloud-api/src/admin/contract/load-candidate.ts',
    'apps/cloud-api/src/admin/contract/service.ts',
    'scripts/qa09-contract-load-detail-proof.mjs',
    'scripts/qa09-contract-load-proof.mjs',
    'pnpm-lock.yaml',
    'node_modules/@prisma/adapter-pg/dist/index.mjs',
    'node_modules/@prisma/client/runtime/client.js',
  ].map((path) => ({ path, sha256: hash(readFileSync(path)) }));
  const rows = [];
  for (const name of Object.keys(windowCases)) {
    const output = root + '/' + name + '.json',
      args = ['node_modules/vitest/vitest.mjs', 'run', 'packages/database/test/contract-windows-offline.test.ts'];
    writeFileSync(
      root + '/' + name + '.command.json',
      JSON.stringify({ command: [process.execPath, ...args], case: name, deadlineMs: 45000 }) + '\n',
    );
    const child = spawnSync(process.execPath, args, {
      env: { ...process.env, QA09_WINDOWS_CASE: name, QA09_WINDOWS_OUTPUT: output },
      timeout: 45000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(root + '/' + name + '.log', (child.stdout ?? '') + (child.stderr ?? ''));
    writeFileSync(root + '/' + name + '.exit', String(child.status ?? -1) + '\n');
    if (child.status !== 0) {
      writeFileSync(
        root + '/failure.json',
        JSON.stringify({
          gate: 'FAIL',
          case: name,
          completedCases: rows.length,
          timeout: child.error?.code === 'ETIMEDOUT',
        }) + '\n',
      );
      throw Error('WINDOW_CHILD_FAILED');
    }
    const bytes = readFileSync(output),
      receipt = JSON.parse(bytes);
    rows.push({ case: name, receipt: name + '.json', sha256: hash(bytes), samples: summarizeContractWindows(receipt) });
  }
  const result = {
    gate: 'PASS',
    scope: 'OFFLINE_PUBLIC_PORT_BOUNDARIES_AND_CONTROLLED_COST_LOCATION',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    budget: {
      childProcesses: 16,
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
    compilerOnlyAttribution: false,
    serverExecutionIsolated: false,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
  writeFileSync(root + '/matrix.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('OUTPUT_DIRECTORY_REQUIRED');
  const r = runContractWindows(process.argv[2]);
  console.log(JSON.stringify({ gate: r.gate, cases: r.rows.length, networkRequests: 0 }));
}
