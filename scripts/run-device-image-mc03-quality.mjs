#!/usr/bin/env node
/** Freeze only a committed candidate; append evidence in one directory, no cloud/credential use. */
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  EVIDENCE,
  git,
  gitFiles,
  sourceSnapshot,
  verifySnapshot,
  hash,
  digest,
  need,
} from './device-image-version-binding.mjs';
import { freezeLocalEvidence } from './device-image-candidate.mjs';
const c = process.argv[2];
need(
  /^[a-f0-9]{40}$/u.test(c ?? '') && git(['rev-parse', 'HEAD']).toString().trim() === c,
  'EXACT_COMMITTED_HEAD_REQUIRED',
);
const frozen = sourceSnapshot(c);
verifySnapshot(frozen);
const e = resolve(ROOT, EVIDENCE),
  dir = resolve(e, 'quality');
mkdirSync(dir, { recursive: true });
const seq = readdirSync(dir).filter((n) => n.startsWith('attempt-')).length + 1,
  attempt = `quality/attempt-${String(seq).padStart(2, '0')}`,
  cwd = resolve(e, attempt);
mkdirSync(cwd, { recursive: true });
const guard = resolve(cwd, 'network-guard.log');
writeFileSync(guard, '');
const pnpm = process.env.FDP_MC03_PNPM ?? 'pnpm';
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_') && !k.startsWith('QA09_'))),
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_CLI_AUTO_PROMPT: 'off',
  TURBO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  FDP_MC03_OFFLINE_GUARD_LOG: guard,
  NODE_OPTIONS: '--import=' + pathToFileURL(resolve(ROOT, 'scripts/test-support/image-mc03-offline-guard.mjs')).href,
};
const checks = [];
const now = () => new Date().toISOString();
function ref(path) {
  return { path, sha256: hash(readFileSync(resolve(e, path))) };
}
function save(path, v) {
  const f = resolve(e, path);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
  return ref(path);
}
async function run(id, command, bin, args) {
  const startedAt = now(),
    path = attempt + '/' + id + '.log',
    fd = openSync(resolve(e, path), 'w');
  process.stdout.write(`RUN ${id}\n`);
  const exitCode = await new Promise((res) => {
    const child = spawn(bin, args, { cwd: ROOT, env, stdio: ['ignore', fd, fd] });
    child.once('error', () => res(127));
    child.once('exit', (code) => res(code ?? 128));
  });
  closeSync(fd);
  const result = {
    id,
    command,
    startedAt,
    finishedAt: now(),
    exitCode,
    status: exitCode === 0 ? 'PASS' : 'FAIL',
    log: ref(path),
  };
  checks.push(result);
  process.stdout.write(`${result.status} ${id} (${exitCode})\n`);
  need(exitCode === 0, 'QUALITY_COMMAND_FAILED:' + id);
  return result;
}
const specialized = [
  'device-contracts',
  'iot-integration',
  'core-api-integration',
  'admin-e2e',
  'security',
  'reliability',
  'prototype-regression',
];
const commands = JSON.parse(gitFiles(c, ['package.json'])['package.json']).scripts.verify.split(' && ');
need(commands.length === 22, 'VERIFY_SCOPE_CHANGED');
const independentIds = [
  'tool-typecheck',
  'protocol-bridge-typecheck',
  'tool-tests',
  'tool-synth',
  'tool-package',
  'tool-reproducibility',
  'version-protocol-tests',
  'legacy-package-check',
];
const stageFiles = () => {
  const dir = resolve(ROOT, 'build/img21-mc02');
  return Object.fromEntries(
    [
      ...readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => f.name),
      ...readdirSync(resolve(dir, 'code')).map((n) => 'code/' + n),
    ]
      .sort()
      .map((p) => [p, hash(readFileSync(resolve(dir, p)))]),
  );
};
try {
  const full = await run('full-verify', 'pnpm verify', pnpm, ['verify']);
  const receipts = [];
  for (const id of specialized) {
    const p = `/tmp/fdp-${id}-gate.json`;
    need(existsSync(p), 'MISSING_SPECIALIZED_RECEIPT:' + id);
    const b = readFileSync(p),
      r = JSON.parse(b);
    need(r.status === 'PASS' && r.baselineCommit === c, 'SPECIALIZED_RECEIPT_SOURCE_DRIFT:' + id);
    const target = `${attempt}/${id}-receipt.json`;
    writeFileSync(resolve(e, target), b);
    receipts.push({ id, status: 'PASS', artifact: ref(target) });
  }
  await run('tool-typecheck', 'pnpm exec tsc -p tools/img21/tsconfig.json', pnpm, [
    'exec',
    'tsc',
    '-p',
    'tools/img21/tsconfig.json',
  ]);
  await run('protocol-bridge-typecheck', 'pnpm exec tsc -p tools/image-acceptance/tsconfig.json', pnpm, [
    'exec',
    'tsc',
    '-p',
    'tools/image-acceptance/tsconfig.json',
  ]);
  await run('tool-tests', 'pnpm exec vitest run --config tools/img21/vitest.config.mts', pnpm, [
    'exec',
    'vitest',
    'run',
    '--config',
    'tools/img21/vitest.config.mts',
  ]);
  await run('tool-synth', 'node --import tsx tools/img21/local-synth.ts', process.execPath, [
    '--import',
    'tsx',
    'tools/img21/local-synth.ts',
  ]);
  await run('tool-package', 'python3 scripts/test-support/image-mc03-tool-package.py', 'python3', [
    'scripts/test-support/image-mc03-tool-package.py',
  ]);
  const before = stageFiles();
  await run(
    'tool-reproducibility',
    'node --import tsx tools/img21/local-synth.ts (repeat; compare bytes)',
    process.execPath,
    ['--import', 'tsx', 'tools/img21/local-synth.ts'],
  );
  need(digest(before) === digest(stageFiles()), 'TOOL_BUILD_NOT_REPRODUCIBLE');
  save(attempt + '/reproducibility.json', { status: 'PASS', fileCount: Object.keys(before).length, files: before });
  await run(
    'version-protocol-tests',
    'node --import tsx --test scripts/device-image-version-binding.test.mjs scripts/device-image-target-package.test.mjs',
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      'scripts/device-image-version-binding.test.mjs',
      'scripts/device-image-target-package.test.mjs',
    ],
  );
  await run('legacy-package-check', 'node scripts/device-image-target-package.mjs --check', process.execPath, [
    'scripts/device-image-target-package.mjs',
    '--check',
  ]);
  need(readFileSync(guard).length === 0, 'NON_LOOPBACK_ATTEMPTS_BLOCKED');
  verifySnapshot(frozen);
  const quality = {
    status: 'PASS_LOCAL',
    mode: 'LOCAL_FIXTURES_ONLY',
    fullVerifyExecution: full,
    fullVerifyStages: commands.map((command) => ({ command, status: 'PASS', exitCode: 0, log: full.log })),
    independentChecks: checks.slice(1),
    specializedReceipts: receipts,
    guardLog: ref(attempt + '/network-guard.log'),
    reproducibility: ref(attempt + '/reproducibility.json'),
    cloudCalls: 0,
    g4: 'NOT_RUN',
  };
  const bundleManifest = JSON.parse(readFileSync(resolve(ROOT, 'build/img21-mc02/code/artifacts.json')));
  const result = freezeLocalEvidence(c, quality, bundleManifest);
  save(attempt + '/execution.json', { ...result, checks });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (e) {
  save(attempt + '/execution.json', {
    status: 'FAIL',
    candidate: c,
    reason: String(e.message),
    checks,
    notRun: independentIds.filter((id) => !checks.some((r) => r.id === id)),
    g4: 'NOT_RUN',
  });
  process.stderr.write(String(e.message) + '\n');
  process.exitCode = 1;
}
