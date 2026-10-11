import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cpuCases, summarizeCpuCase } from './qa09-contract-cpu-proof.mjs';
import { analyzeHistory } from './analyze-qa09-public-cpu-history.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const demand = (v, c) => {
  if (!v) throw Error(c);
};
const baseline = '12d57befe55be1e1abfd1e226c2d13cbace992dc';
const rootFiles = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, resolve(e.parentPath, e.name)))
    .filter((p) => p !== 'manifest.json')
    .sort();
export function verifyBindings(root, files) {
  for (const [path, digest] of Object.entries(files)) {
    demand(
      !path.startsWith('/') && !path.split('/').includes('..') && /^[a-f0-9]{64}$/.test(digest),
      'OFFLINE_BINDING_PATH',
    );
    demand(hash(readFileSync(resolve(root, path))) === digest, 'OFFLINE_BINDING:' + path);
  }
}
export function checkOffline(root) {
  const matrixBytes = readFileSync(root + '/matrix-03/matrix.json'),
    matrix = JSON.parse(matrixBytes);
  demand(
    matrix.gate === 'PASS' &&
      matrix.rows.length === 14 &&
      matrix.candidateDefaultsChanged === false &&
      matrix.targetEquivalent === false &&
      matrix.p95Accepted === false &&
      matrix.fullQa09Accepted === false &&
      matrix.afterQueueAttribution === 'UNRESOLVED_NO_STABLE_COMPILER_SEAM',
    'OFFLINE_MATRIX_SCOPE',
  );
  verifyBindings(process.cwd(), Object.fromEntries(matrix.inputs.map((i) => [i.path, i.sha256])));
  demand(
    JSON.stringify(matrix.rows.map((r) => r.case)) === JSON.stringify(Object.keys(cpuCases)),
    'OFFLINE_MATRIX_CASES',
  );
  const costs = [],
    counts = {};
  for (const row of matrix.rows) {
    demand(row.receipt === row.case + '.json', 'OFFLINE_RECEIPT_PATH');
    const bytes = readFileSync(root + '/matrix-03/' + row.receipt);
    demand(row.receipt === row.case + '.json' && hash(bytes) === row.sha256, 'OFFLINE_RECEIPT_BINDING');
    const r = JSON.parse(bytes),
      proof = summarizeCpuCase(r);
    if (r.profile)
      demand(
        r.probe.measurements.every((m) => m.start >= r.profile.startTime - 100 && m.end <= r.profile.endTime + 100),
        'OFFLINE_ACCOUNT_PROFILE_COVERAGE',
      );
    demand(
      JSON.stringify(proof) === JSON.stringify(row.summary) && JSON.stringify(r.counts) === JSON.stringify(row.counts),
      'OFFLINE_SUMMARY',
    );
    for (const [key, value] of Object.entries(r.counts)) counts[key] = (counts[key] ?? 0) + value;
    const account = proof.measurements.find((m) => m.name === 'account'),
      first = proof.samples[0];
    costs.push({
      case: r.case,
      accountWallMs: (account.end - account.start) / 1000,
      accountProcessCpuMs: account.processCpuUs / 1000,
      firstOperationWallMs: first.windowsMs,
      firstOperationProcessCpuUs: first.windowsCpuUs,
      accountPlusFirstLoadMs: (account.end - account.start) / 1000 + first.windowsMs.load,
      profileSamples: proof.profileSamples,
      firstPublicWindows: first.cpu,
    });
  }
  demand(
    counts.begin === 34 &&
      counts.checkout === 48 &&
      counts.release === 48 &&
      counts.pools === 14 &&
      counts.dispose === 14 &&
      counts.network === 0,
    'OFFLINE_TOTAL_OWNERSHIP',
  );
  const history = analyzeHistory('docs/audit/evidence/qa-09-12d57be-r0-r1-2026-10-10');
  demand(
    JSON.stringify(history) === JSON.stringify(JSON.parse(readFileSync(root + '/history.json'))),
    'OFFLINE_HISTORY_REPLAY',
  );
  execFileSync('git', [
    'diff',
    '--quiet',
    baseline,
    '--',
    '.github',
    'infra',
    'apps',
    'packages/database/src',
    'packages/observability/src',
  ]);
  return {
    gate: 'PASS',
    scope: 'LOCAL_OFFLINE_ONLY',
    baselineApplication: baseline,
    finalMatrixSha256: hash(matrixBytes),
    counts,
    costs,
    verifiedHistoricalFiles: history.verifiedHistoricalFiles,
    candidateDefaultsChanged: false,
    additionalRequests: 0,
    afterQueueAttribution: 'UNRESOLVED_NO_STABLE_COMPILER_SEAM',
    targetNewSha: 'NOT_RUN',
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
const sources = [
  'scripts/check-qa09-public-cpu-offline.mjs',
  'scripts/check-qa09-public-cpu-offline.test.mjs',
  'scripts/run-qa09-contract-cpu-runtime.mjs',
  'scripts/qa09-contract-cpu-proof.mjs',
  'scripts/qa09-contract-cpu-proof.d.mts',
  'scripts/qa09-contract-cpu-proof.test.mjs',
  'scripts/analyze-qa09-public-cpu-history.mjs',
  'scripts/analyze-qa09-public-cpu-history.test.mjs',
  'scripts/check-secrets.mjs',
  'scripts/check-secrets.test.mjs',
  'packages/database/test/contract-cpu-runtime.test.ts',
  'packages/database/test/helpers/contract-cpu-probe.ts',
  'docs/dev/QA-09-公开入口CPU归属与三窗口离线对照.md',
  'docs/audit/QA-09-425ms公开入口CPU归属与独立传输诊断-2026-10-11.md',
  'docs/管理后台开发任务清单.md',
];
export function runOfflineCheck(mode, root) {
  const result = checkOffline(root),
    summaryPath = root + '/offline-comparison.json';
  if (mode === '--summarize') {
    demand(!existsSync(summaryPath), 'FRESH_OFFLINE_SUMMARY_REQUIRED');
    writeFileSync(summaryPath, JSON.stringify(result, null, 2) + '\n');
  } else {
    demand(
      JSON.stringify(result) === JSON.stringify(JSON.parse(readFileSync(summaryPath))),
      'OFFLINE_COMPARISON_BINDING',
    );
    if (mode === '--seal') {
      demand(!existsSync(root + '/manifest.json'), 'FRESH_OFFLINE_SEAL_REQUIRED');
      const files = Object.fromEntries(rootFiles(root).map((path) => [path, hash(readFileSync(root + '/' + path))]));
      const bindings = Object.fromEntries(sources.map((path) => [path, hash(readFileSync(path))]));
      writeFileSync(
        root + '/manifest.json',
        JSON.stringify(
          {
            seal: 'PASS',
            gate: 'LOCAL_OFFLINE_PASS',
            overallQa09: 'PARTIAL',
            baselineApplication: baseline,
            candidateDefaultsChanged: false,
            fileCount: Object.keys(files).length,
            files,
            bindings,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      demand(mode === '--check', 'OFFLINE_CHECK_MODE');
      const manifest = JSON.parse(readFileSync(root + '/manifest.json'));
      demand(
        manifest.seal === 'PASS' &&
          manifest.gate === 'LOCAL_OFFLINE_PASS' &&
          manifest.overallQa09 === 'PARTIAL' &&
          manifest.baselineApplication === baseline &&
          manifest.candidateDefaultsChanged === false,
        'OFFLINE_SEAL_SCOPE',
      );
      demand(
        JSON.stringify(rootFiles(root)) === JSON.stringify(Object.keys(manifest.files).sort()) &&
          manifest.fileCount === Object.keys(manifest.files).length,
        'OFFLINE_SEAL_FILESET',
      );
      demand(JSON.stringify(Object.keys(manifest.bindings)) === JSON.stringify(sources), 'OFFLINE_SEAL_SOURCESET');
      verifyBindings(root, manifest.files);
      verifyBindings(process.cwd(), manifest.bindings);
    }
  }
  return {
    gate: result.gate,
    scope: result.scope,
    cases: 14,
    transactions: result.counts.begin,
    targetNewSha: result.targetNewSha,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  demand(process.argv.length === 4, 'OFFLINE_CHECK_ARGUMENTS');
  console.log(JSON.stringify(runOfflineCheck(process.argv[2], resolve(process.argv[3]))));
}
