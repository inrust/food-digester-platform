import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { entryOutputCases, validateEntryOutputReceipt } from './qa09-contract-entry-output-proof.mjs';
import { buildEntryOutputTargetPlan } from './qa09-contract-entry-output-plan.mjs';
import { checkOffline, verifyBindings } from './check-qa09-public-cpu-offline.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const demand = (v, c) => {
  if (!v) throw Error(c);
};
const previous = 'docs/audit/evidence/qa-09-public-cpu-offline-2026-10-11';
const rootFiles = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, resolve(e.parentPath, e.name)))
    .filter((p) => p !== 'manifest.json')
    .sort();
export function validateDesignMatrix(matrix, load) {
  demand(
    matrix.gate === 'PASS' &&
      matrix.scope === 'OFFLINE_PUBLIC_ENTRY_OUTPUT_OWNERSHIP' &&
      matrix.candidateDefaultsChanged === false &&
      matrix.targetEquivalent === false &&
      matrix.targetWiring === 'NOT_IMPLEMENTED' &&
      matrix.p95Accepted === false &&
      matrix.fullQa09Accepted === false,
    'DESIGN_MATRIX_SCOPE',
  );
  demand(JSON.stringify(matrix.rows.map((r) => r.case)) === JSON.stringify(entryOutputCases), 'DESIGN_MATRIX_CASES');
  const b = matrix.budget;
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
    'DESIGN_MATRIX_BUDGET',
  );
  const counts = {},
    samples = [];
  let maxRecords = 0,
    maxSummaryBytes = 0,
    degraded = 0;
  for (const row of matrix.rows) {
    demand(row.receipt === row.case + '.json', 'DESIGN_RECEIPT_PATH');
    const bytes = load(row.receipt);
    demand(hash(bytes) === row.sha256, 'DESIGN_RECEIPT_HASH');
    const r = JSON.parse(bytes),
      proof = validateEntryOutputReceipt(r);
    demand(
      JSON.stringify(proof) === JSON.stringify(row.summary) && JSON.stringify(r.counts) === JSON.stringify(row.counts),
      'DESIGN_PROOF_REPLAY',
    );
    for (const [key, n] of Object.entries(r.counts)) counts[key] = (counts[key] ?? 0) + n;
    for (const s of proof) {
      maxRecords = Math.max(maxRecords, s.proof.records);
      maxSummaryBytes = Math.max(maxSummaryBytes, s.proof.proposedSummaryBytes ?? 0);
      if (s.proof.gate === 'EXPECTED_DEGRADED') degraded++;
    }
    samples.push({ case: row.case, first: proof[0] });
  }
  demand(
    counts.begin === 34 &&
      counts.checkout === 48 &&
      counts.release === 48 &&
      counts.pools === 14 &&
      counts.dispose === 14 &&
      counts.network === 0 &&
      degraded === 9,
    'DESIGN_OWNERSHIP_TOTALS',
  );
  return { counts, maxRecords, maxSummaryBytes, expectedDegradedSamples: degraded, samples };
}
export function checkEntryOutputDesign(root) {
  const bytes = readFileSync(root + '/matrix-04/matrix.json'),
    matrix = JSON.parse(bytes);
  verifyBindings(process.cwd(), Object.fromEntries(matrix.inputs.map((i) => [i.path, i.sha256])));
  const replay = validateDesignMatrix(matrix, (name) => readFileSync(root + '/matrix-04/' + name));
  const plan = buildEntryOutputTargetPlan();
  demand(
    JSON.stringify(plan) === JSON.stringify(JSON.parse(readFileSync(root + '/target-plan-final.json'))),
    'DESIGN_PLAN_REPLAY',
  );
  const oldBytes = readFileSync(previous + '/manifest.json'),
    old = JSON.parse(oldBytes);
  const committed = execFileSync('git', [
    'show',
    '072b6bdf576383457ca930a3698dfaeb9f0d6fa1:' + previous + '/manifest.json',
  ]);
  demand(
    hash(oldBytes) === hash(committed) &&
      old.seal === 'PASS' &&
      old.fileCount === 185 &&
      Object.keys(old.files).length === 185,
    'DESIGN_PREVIOUS_SEAL',
  );
  verifyBindings(previous, old.files);
  // Only the task-list's historical external binding may advance; all previous evidence/source/docs stay fixed.
  verifyBindings(
    process.cwd(),
    Object.fromEntries(Object.entries(old.bindings).filter(([p]) => p !== 'docs/管理后台开发任务清单.md')),
  );
  const historical = checkOffline(previous);
  demand(
    JSON.stringify(historical) === JSON.stringify(JSON.parse(readFileSync(previous + '/offline-comparison.json'))),
    'DESIGN_PREVIOUS_REPLAY',
  );
  execFileSync('git', [
    'diff',
    '--quiet',
    '072b6bdf576383457ca930a3698dfaeb9f0d6fa1',
    '--',
    '.github',
    'infra',
    'apps',
    'packages/database/src',
    'packages/observability/src',
  ]);
  demand(
    !readFileSync('apps/cloud-api/src/runtime/lambda-entry.ts', 'utf8').includes(plan.flag.name) &&
      !readFileSync('.github/workflows/deploy-test.yml', 'utf8').includes(plan.flag.name),
    'DESIGN_NOT_WIRED',
  );
  return {
    gate: 'LOCAL_DESIGN_AND_OWNERSHIP_PASS',
    finalMatrixSha256: hash(bytes),
    previousManifestSha256: hash(oldBytes),
    previousSealedFiles: 185,
    historicalTargetFiles: historical.verifiedHistoricalFiles,
    ...replay,
    plan,
    decision: 'PROCEED_WITH_DEFAULT_OFF_OBSERVATION_IMPLEMENTATION_NEXT_TASK',
    targetWiring: 'NOT_IMPLEMENTED',
    additionalRequests: 0,
    compilerOnlyAttribution: false,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
const sources = [
  'scripts/check-qa09-entry-output-design.mjs',
  'scripts/check-qa09-entry-output-design.test.mjs',
  'scripts/run-qa09-contract-entry-output-runtime.mjs',
  'scripts/qa09-contract-entry-output-proof.mjs',
  'scripts/qa09-contract-entry-output-proof.d.mts',
  'scripts/qa09-contract-entry-output-proof.test.mjs',
  'scripts/qa09-contract-entry-output-plan.mjs',
  'scripts/qa09-contract-entry-output-plan.test.mjs',
  'packages/database/test/contract-entry-output-runtime.test.ts',
  'packages/database/test/contract-entry-output-ownership.test.ts',
  'packages/database/test/helpers/contract-entry-output-probe.ts',
  'docs/dev/QA-09-公开入口与恢复后日志预算分界方案.md',
  'docs/audit/QA-09-公开入口与恢复后日志接缝所有权验证-2026-10-11.md',
  'docs/管理后台开发任务清单.md',
];
export function runDesignCheck(mode, root) {
  const result = checkEntryOutputDesign(root),
    summary = root + '/decision-final.json';
  if (mode === '--summarize') {
    demand(!existsSync(summary), 'FRESH_DESIGN_DECISION_REQUIRED');
    writeFileSync(summary, JSON.stringify(result, null, 2) + '\n');
  } else {
    demand(JSON.stringify(result) === JSON.stringify(JSON.parse(readFileSync(summary))), 'DESIGN_DECISION_BINDING');
    if (mode === '--seal') {
      demand(!existsSync(root + '/manifest.json'), 'FRESH_DESIGN_SEAL_REQUIRED');
      const files = Object.fromEntries(rootFiles(root).map((p) => [p, hash(readFileSync(root + '/' + p))]));
      const bindings = Object.fromEntries(sources.map((p) => [p, hash(readFileSync(p))]));
      writeFileSync(
        root + '/manifest.json',
        JSON.stringify(
          {
            seal: 'PASS',
            gate: result.gate,
            overallQa09: 'PARTIAL',
            targetWiring: 'NOT_IMPLEMENTED',
            fileCount: Object.keys(files).length,
            files,
            bindings,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      demand(mode === '--check', 'DESIGN_MODE');
      const m = JSON.parse(readFileSync(root + '/manifest.json'));
      demand(
        m.seal === 'PASS' &&
          m.gate === result.gate &&
          m.overallQa09 === 'PARTIAL' &&
          m.targetWiring === 'NOT_IMPLEMENTED',
        'DESIGN_SEAL_SCOPE',
      );
      demand(
        JSON.stringify(rootFiles(root)) === JSON.stringify(Object.keys(m.files).sort()) &&
          m.fileCount === Object.keys(m.files).length,
        'DESIGN_SEAL_FILES',
      );
      demand(JSON.stringify(Object.keys(m.bindings)) === JSON.stringify(sources), 'DESIGN_SEAL_SOURCES');
      verifyBindings(root, m.files);
      verifyBindings(process.cwd(), m.bindings);
    }
  }
  return {
    gate: result.gate,
    cases: 14,
    transactions: result.counts.begin,
    maxRecords: result.maxRecords,
    maxSummaryBytes: result.maxSummaryBytes,
    targetWiring: 'NOT_IMPLEMENTED',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length === 4, 'DESIGN_CHECK_ARGUMENTS');
  console.log(JSON.stringify(runDesignCheck(process.argv[2], resolve(process.argv[3]))));
}
