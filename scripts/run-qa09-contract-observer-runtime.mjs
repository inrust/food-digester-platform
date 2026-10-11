import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { entryOutputCases } from './qa09-contract-entry-output-proof.mjs';
import { validateObserverRuntimeReceipt } from './qa09-contract-observer-proof.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export function runObserverRuntimeMatrix(directory) {
  const root = resolve(directory);
  if (existsSync(root)) throw Error('FRESH_OBSERVER_DIRECTORY_REQUIRED');
  mkdirSync(root, { recursive: true });
  const inputs = [
    'scripts/run-qa09-contract-observer-runtime.mjs',
    'scripts/qa09-contract-observer-proof.mjs',
    'packages/observability/src/contract-observer-cost.ts',
    'packages/observability/test/contract-observer-cost.test.ts',
    'apps/cloud-api/src/admin/contract/service.ts',
    'apps/cloud-api/src/runtime/admin-engine-diagnostic.ts',
    'apps/cloud-api/test/admin-observer-entry.test.ts',
    'infra/src/config.ts',
    'infra/src/stacks/app-dependencies-stack.ts',
    'scripts/esgiot-cdk.mjs',
    'scripts/record-qa09-deployment-inputs.mjs',
    'scripts/qa09-account-read-config.mjs',
    'scripts/collect-qa09-contract-correlation.py',
    'scripts/qa09_observer_cost.py',
    'scripts/check-qa09-contract-phases.mjs',
    '.github/workflows/deploy-test.yml',
    'scripts/qa09-contract-entry-output-proof.mjs',
    'scripts/qa09-contract-entry-output-proof.d.mts',
    'scripts/qa09-contract-entry-output-proof.test.mjs',
    'packages/database/test/contract-observer-runtime.test.ts',
    'packages/database/test/contract-entry-output-ownership.test.ts',
    'packages/database/test/helpers/contract-entry-output-probe.ts',
    'packages/database/test/helpers/contract-cpu-probe.ts',
    'scripts/qa09-contract-public-proof.mjs',
    'scripts/run-qa09-contract-public-runtime.mjs',
    'scripts/qa09-contract-load-detail-proof.mjs',
    'scripts/qa09-contract-load-proof.mjs',
    'packages/database/src/client.ts',
    'packages/database/src/client-preparation.ts',
    'packages/database/src/contract-load-observation.ts',
    'packages/database/src/contract-load-pg-lease.ts',
    'packages/database/src/observed-pg.ts',
    'packages/observability/src/data-path.ts',
    'packages/observability/src/redaction.ts',
    'apps/cloud-api/src/runtime/lambda-entry.ts',
    'apps/cloud-api/src/admin/contract/load-candidate.ts',
    'apps/cloud-api/src/admin/user/account-read-candidate.ts',
    'packages/database/prisma/schema.prisma',
    'pnpm-lock.yaml',
    'node_modules/@prisma/adapter-pg/dist/index.mjs',
    'node_modules/@prisma/adapter-pg/dist/index.js',
    'node_modules/@prisma/adapter-pg/dist/index.d.ts',
    'node_modules/@prisma/client/runtime/client.mjs',
    'packages/database/src/generated/client.ts',
    'packages/database/src/generated/internal/class.ts',
    'node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs',
    'node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs',
  ].map((path) => ({ path, sha256: hash(readFileSync(path)) }));
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NO_COLOR']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const rows = [];
  try {
    for (const name of entryOutputCases) {
      const output = root + '/' + name + '.json',
        args = ['node_modules/vitest/vitest.mjs', 'run', 'packages/database/test/contract-observer-runtime.test.ts'];
      writeFileSync(
        root + '/' + name + '.command.json',
        JSON.stringify({
          command: [process.execPath, ...args],
          case: name,
          deadlineMs: 45000,
          environmentKeys: Object.keys(env),
        }) + '\n',
      );
      const child = spawnSync(process.execPath, args, {
        env: { ...env, QA09_OBSERVER_CASE: name, QA09_OBSERVER_OUTPUT: output },
        timeout: 45000,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      writeFileSync(root + '/' + name + '.log', (child.stdout ?? '') + (child.stderr ?? ''));
      writeFileSync(root + '/' + name + '.exit', String(child.status ?? -1) + '\n');
      if (child.status !== 0) throw Error('OBSERVER_CHILD_FAILED:' + name);
      const bytes = readFileSync(output),
        receipt = JSON.parse(bytes);
      rows.push({
        case: name,
        receipt: name + '.json',
        sha256: hash(bytes),
        counts: receipt.counts,
        summary: validateObserverRuntimeReceipt(receipt),
      });
    }
    for (const input of inputs)
      if (hash(readFileSync(input.path)) !== input.sha256) throw Error('OBSERVER_INPUT_DRIFT');
    const result = {
      gate: 'PASS',
      scope: 'LOCAL_PRODUCTION_OBSERVER_CONTROLLED_RUNTIME',
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      budget: {
        childProcesses: 14,
        concurrency: 1,
        childDeadlineMs: 45000,
        poolMax: 1,
        networkRequests: 0,
        databaseServers: 0,
        targetFixtures: 0,
        inspectorSessions: 0,
        intervalRecordsPerRequestMax: 64,
        plannedSummaryBytesMax: 4096,
        plannedSummaryRecordsPerRequestMax: 1,
      },
      inputs,
      rows,
      candidateDefaultsChanged: false,
      targetWiring: 'IMPLEMENTED_DEFAULT_OFF_NOT_DEPLOYED',
      observationDesignDecision: 'PUBLIC_ENTRY_AND_OUTPUT_ONLY_DEFAULT_OFF',
      targetEquivalent: false,
      afterQueueAttribution: 'UNRESOLVED_NO_STABLE_COMPILER_SEAM',
      compilerOnlyAttribution: false,
      p95Accepted: false,
      fullQa09Accepted: false,
    };
    writeFileSync(root + '/matrix.json', JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    writeFileSync(
      root + '/failure.json',
      JSON.stringify(
        { gate: 'FAIL', completed: rows.map((r) => r.case), code: String(error), retry: false, inputs },
        null,
        2,
      ) + '\n',
    );
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('OUTPUT_DIRECTORY_REQUIRED');
  const r = runObserverRuntimeMatrix(process.argv[2]);
  console.log(JSON.stringify({ gate: r.gate, cases: r.rows.length, networkRequests: 0 }));
}
