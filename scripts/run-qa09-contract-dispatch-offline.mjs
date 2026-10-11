import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dispatchCases, validateDispatchReceipt } from './qa09-contract-dispatch-proof.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export function runDispatchMatrix(directory) {
  const root = resolve(directory);
  if (existsSync(root)) throw Error('FRESH_DISPATCH_DIRECTORY_REQUIRED');
  mkdirSync(root, { recursive: true });
  const inputs = [
    'scripts/run-qa09-contract-dispatch-offline.mjs',
    'scripts/qa09-contract-dispatch-proof.mjs',
    'scripts/qa09-contract-dispatch-proof.d.mts',
    'scripts/qa09-contract-public-proof.mjs',
    'scripts/run-qa09-contract-public-runtime.mjs',
    'scripts/qa09-contract-load-detail-proof.mjs',
    'scripts/qa09-contract-load-proof.mjs',
    'packages/database/test/contract-dispatch-offline.test.ts',
    'packages/database/test/helpers/contract-cpu-probe.ts',
    'packages/database/test/helpers/contract-dispatch-probe.ts',
    'packages/database/test/helpers/contract-entry-output-probe.ts',
    'scripts/qa09-contract-entry-output-proof.mjs',
    'scripts/qa09-contract-cpu-proof.mjs',
    'infra/src/stacks/app-dependencies-stack.ts',
    '.github/workflows/deploy-test.yml',
    'apps/cloud-api/src/runtime/lambda-entry.ts',
    'apps/cloud-api/src/runtime/admin-engine-diagnostic.ts',
    'scripts/qa09-contract-dispatch-proof.test.mjs',
    'packages/database/src/client.ts',
    'packages/database/src/client-preparation.ts',
    'packages/database/src/contract-load-observation.ts',
    'packages/database/src/contract-load-pg-lease.ts',
    'packages/database/src/observed-pg.ts',
    'packages/observability/src/data-path.ts',
    'apps/cloud-api/src/admin/contract/load-candidate.ts',
    'apps/cloud-api/src/admin/user/account-read-candidate.ts',
    'packages/database/prisma/schema.prisma',
    'pnpm-lock.yaml',
    'node_modules/@prisma/adapter-pg/dist/index.mjs',
    'node_modules/@prisma/adapter-pg/dist/index.js',
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
    for (const name of Object.keys(dispatchCases)) {
      const output = root + '/' + name + '.json',
        args = ['node_modules/vitest/vitest.mjs', 'run', 'packages/database/test/contract-dispatch-offline.test.ts'];
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
        env: { ...env, QA09_DISPATCH_CASE: name, QA09_DISPATCH_OUTPUT: output },
        timeout: 45000,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      writeFileSync(root + '/' + name + '.log', (child.stdout ?? '') + (child.stderr ?? ''));
      writeFileSync(root + '/' + name + '.exit', String(child.status ?? -1) + '\n');
      if (child.status !== 0) throw Error('DISPATCH_CHILD_FAILED:' + name);
      const bytes = readFileSync(output),
        receipt = JSON.parse(bytes);
      rows.push({
        case: name,
        receipt: name + '.json',
        sha256: hash(bytes),
        counts: receipt.counts,
        summary: validateDispatchReceipt(receipt),
      });
    }
    for (const input of inputs)
      if (hash(readFileSync(input.path)) !== input.sha256) throw Error('DISPATCH_INPUT_DRIFT');
    const result = {
      gate: 'PASS',
      scope: 'OFFLINE_DISJOINT_CHECKPOINT_DISPATCH_PREFIX_OWNERSHIP',
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      budget: {
        childProcesses: 16,
        concurrency: 1,
        childDeadlineMs: 45000,
        poolMax: 1,
        networkRequests: 0,
        databaseServers: 0,
        targetFixtures: 0,
        samplingIntervalUs: 1000,
        profileSamplesMax: 45000,
        profileBytesMax: 8388608,
        controlledCpuPerSampleMs: 20,
        forcedYields: 0,
        additionalQueries: 0,
        deploymentActions: 0,
      },
      inputs,
      rows,
      candidateDefaultsChanged: false,
      targetEquivalent: false,
      afterQueueAttribution: 'OFFLINE_CHECKPOINT_AND_ENGINE_DISPATCH_GAP_ONLY',
      targetAfterQueueAttribution: 'UNRESOLVED_NO_STABLE_COMPILER_SEAM',
      targetDriverPrefixAttribution: 'UNRESOLVED_NO_TARGET_RECEIPT',
      readyToDeploy: false,
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
  const r = runDispatchMatrix(process.argv[2]);
  console.log(JSON.stringify({ gate: r.gate, cases: r.rows.length, networkRequests: 0 }));
}
