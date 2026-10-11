import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { entryOutputCases } from './qa09-contract-entry-output-proof.mjs';
import { validateObserverRuntimeReceipt } from './qa09-contract-observer-proof.mjs';
const baseline = '8af60f3cc3bdce65286d2b22865a54d7bb075d5e';
const previous = 'docs/audit/evidence/qa-09-entry-output-design-2026-10-11';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const demand = (v, c) => {
  if (!v) throw Error(c);
};
const verify = (root, files) => {
  for (const [p, h] of Object.entries(files))
    demand(hash(readFileSync(resolve(root, p))) === h, 'IMPLEMENTATION_BINDING:' + p);
};
const inventory = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, resolve(e.parentPath, e.name)))
    .filter((p) => p !== 'manifest.json')
    .sort();
export function validateImplementationMatrix(m, load) {
  demand(
    m.gate === 'PASS' &&
      m.scope === 'LOCAL_PRODUCTION_OBSERVER_CONTROLLED_RUNTIME' &&
      m.targetWiring === 'IMPLEMENTED_DEFAULT_OFF_NOT_DEPLOYED' &&
      m.targetEquivalent === false &&
      m.p95Accepted === false &&
      m.fullQa09Accepted === false &&
      m.candidateDefaultsChanged === false,
    'IMPLEMENTATION_MATRIX_SCOPE',
  );
  demand(JSON.stringify(m.rows.map((r) => r.case)) === JSON.stringify(entryOutputCases), 'IMPLEMENTATION_CASES');
  const b = m.budget;
  demand(
    b.childProcesses === 14 &&
      b.concurrency === 1 &&
      b.childDeadlineMs === 45000 &&
      b.poolMax === 1 &&
      b.networkRequests === 0 &&
      b.databaseServers === 0 &&
      b.targetFixtures === 0 &&
      b.inspectorSessions === 0 &&
      b.intervalRecordsPerRequestMax === 64 &&
      b.plannedSummaryBytesMax === 4096 &&
      b.plannedSummaryRecordsPerRequestMax === 1,
    'IMPLEMENTATION_BUDGET',
  );
  const counts = {},
    statuses = {};
  let maxSummaryBytes = 0,
    maxRecords = 0;
  for (const row of m.rows) {
    demand(row.receipt === row.case + '.json', 'IMPLEMENTATION_RECEIPT_PATH');
    const bytes = load(row.receipt);
    demand(hash(bytes) === row.sha256, 'IMPLEMENTATION_RECEIPT_HASH');
    const receipt = JSON.parse(bytes);
    demand(receipt.case === row.case, 'IMPLEMENTATION_RECEIPT_CASE');
    const replay = validateObserverRuntimeReceipt(receipt);
    demand(
      JSON.stringify(replay) === JSON.stringify(row.summary) &&
        JSON.stringify(receipt.counts) === JSON.stringify(row.counts),
      'IMPLEMENTATION_REPLAY',
    );
    for (const [key, n] of Object.entries(receipt.counts)) counts[key] = (counts[key] ?? 0) + n;
    for (const s of replay.summaries) {
      statuses[s.status] = (statuses[s.status] ?? 0) + 1;
      maxSummaryBytes = Math.max(maxSummaryBytes, s.summaryBytes ?? 0);
      maxRecords = Math.max(maxRecords, s.intervalRecords ?? 0);
    }
  }
  demand(
    counts.begin === 34 &&
      counts.release === 48 &&
      counts.checkout === 48 &&
      counts.dispose === 14 &&
      counts.network === 0 &&
      counts.pools === 14,
    'IMPLEMENTATION_TOTALS',
  );
  demand(
    statuses.OFF === 6 &&
      statuses.COMPLETE === 18 &&
      statuses.OUTPUT_FAILED === 6 &&
      statuses.REENTRANT === 3 &&
      statuses.OWNERSHIP_INVALID === 1,
    'IMPLEMENTATION_DEGRADED',
  );
  return { counts, statuses, maxSummaryBytes, maxRecords };
}
function check(root) {
  const matrix = JSON.parse(readFileSync(root + '/matrix-03/matrix.json'));
  verify('.', Object.fromEntries(matrix.inputs.map((r) => [r.path, r.sha256])));
  const replay = validateImplementationMatrix(matrix, (name) => readFileSync(root + '/matrix-03/' + name));
  const oldBytes = readFileSync(previous + '/manifest.json'),
    old = JSON.parse(oldBytes);
  demand(
    oldBytes.equals(execFileSync('git', ['show', baseline + ':' + previous + '/manifest.json'])),
    'IMPLEMENTATION_OLD_SEAL',
  );
  verify(previous, old.files);
  // Historical source bindings belong to the original commit, not intentionally changed current source.
  for (const [p, h] of Object.entries(old.bindings))
    demand(hash(execFileSync('git', ['show', baseline + ':' + p])) === h, 'IMPLEMENTATION_OLD_SOURCE:' + p);
  const verification = JSON.parse(readFileSync(root + '/verify-commands.json'));
  const expected = JSON.parse(readFileSync('package.json'))
    .scripts.verify.split(' && ')
    .map((c, i) =>
      i === 0
        ? ['pnpm', 'exec', 'eslint', '.', '--ignore-pattern', 'build/']
        : i === 1
          ? ['pnpm', 'exec', 'prettier', '--check', '.', '!build/**']
          : c.split(' '),
    );
  demand(
    verification.complete === true &&
      JSON.stringify(verification.commands.map((c) => c.command)) === JSON.stringify(expected) &&
      verification.commands.every((c) => c.exitCode === 0),
    'IMPLEMENTATION_VERIFY_CHAIN',
  );
  return {
    gate: 'LOCAL_IMPLEMENTATION_PASS',
    scope: 'DEFAULT_OFF_WIRING_AND_LOCAL_CONTROLLED_RUNTIME_ONLY',
    ...replay,
    previousSealedFiles: old.fileCount,
    verificationScope: verification.scope,
    targetWiring: 'IMPLEMENTED_DEFAULT_OFF_NOT_DEPLOYED',
    targetRun: 'NOT_RUN',
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
function sources(matrix) {
  const tracked = execFileSync(
    'git',
    ['diff', '--name-only', baseline, '--', '.github', 'apps', 'infra', 'packages', 'scripts'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const fresh = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', 'apps', 'infra', 'packages', 'scripts'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((p) => /\.(ts|mjs|mts|py)$/.test(p));
  return [
    ...new Set([
      ...tracked,
      ...fresh,
      ...matrix.inputs.map((i) => i.path),
      'package.json',
      'docs/管理后台开发任务清单.md',
      'docs/dev/QA-09-公开入口日志有界观测接线与目标复验.md',
      'docs/audit/QA-09-公开入口日志有界观测实施验收-2026-10-11.md',
    ]),
  ].sort();
}
export function runImplementationCheck(mode, root) {
  const result = check(root),
    decision = root + '/implementation.json';
  if (mode === '--seal') {
    demand(!existsSync(root + '/manifest.json') && !existsSync(decision), 'FRESH_IMPLEMENTATION_SEAL');
    writeFileSync(decision, JSON.stringify(result, null, 2) + '\n');
    const files = Object.fromEntries(inventory(root).map((p) => [p, hash(readFileSync(root + '/' + p))]));
    const bindings = Object.fromEntries(
      sources(JSON.parse(readFileSync(root + '/matrix-03/matrix.json'))).map((p) => [p, hash(readFileSync(p))]),
    );
    writeFileSync(
      root + '/manifest.json',
      JSON.stringify(
        { seal: 'PASS', gate: result.gate, fileCount: Object.keys(files).length, files, bindings },
        null,
        2,
      ) + '\n',
    );
  } else {
    demand(mode === '--check', 'IMPLEMENTATION_MODE');
    demand(JSON.stringify(result) === JSON.stringify(JSON.parse(readFileSync(decision))), 'IMPLEMENTATION_DECISION');
    const manifest = JSON.parse(readFileSync(root + '/manifest.json'));
    demand(
      manifest.seal === 'PASS' &&
        manifest.gate === result.gate &&
        manifest.fileCount === inventory(root).length &&
        JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(inventory(root)),
      'IMPLEMENTATION_SEAL_INVENTORY',
    );
    verify(root, manifest.files);
    verify('.', manifest.bindings);
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length === 4, 'MODE_ROOT_REQUIRED');
  const r = runImplementationCheck(process.argv[2], resolve(process.argv[3]));
  console.log(JSON.stringify(r));
}
