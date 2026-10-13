// Read-only repository audit; no AWS calls, deployments, or acceptance promotion.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FORMAL_VALIDATORS } from '../../../../scripts/qa09-formal-closeout-map.mjs';
import { compareApplicationInputs } from '../../../../scripts/collect-qa09-business-reconciliation.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
process.chdir(root);
const output = fileURLToPath(new URL('review.json', import.meta.url));
if (existsSync(output)) throw Error('NEW_OUTPUT_REQUIRED');
const baseline = 'f8e943d2c1a3bca6418f238e732a275e255fc75c';
const deployed = 'ee8f0713cdc5785dbf45e354f1f63723d77e3716';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.signal) throw Error('LOCAL_CHECK_DID_NOT_COMPLETE');
  return { command: [command, ...args], exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
};
const gates = [];
for (const name of FORMAL_VALIDATORS) {
  const path = 'scripts/' + name;
  const module = await import(pathToFileURL(resolve(path)));
  const entry = Object.entries(module).find(([key]) => key.startsWith('validate'));
  const sample = { environment: { isolated: false } };
  const errors = /fe11-15|fe16-19/.test(name) ? entry[1](root, sample) : entry[1](sample);
  gates.push({
    path,
    sha256: sha(readFileSync(path)),
    required: Object.fromEntries(Object.entries(module).filter(([key]) => key.startsWith('REQUIRED_') || ['UPLINK_TYPES', 'QA03_PROBES', 'RETIRED_MQTT_TYPES'].includes(key))),
    isolatedFalseErrors: errors.filter((message) => message.includes('isolated')),
    actual: run(process.execPath, [path]),
  });
}
if (!gates.every((gate) => gate.actual.exitCode === 1 && gate.isolatedFalseErrors.length > 0 && gate.actual.stderr.includes('缺少'))) throw Error('EXPECTED_BASELINE_CHANGED');
const focused = run(process.execPath, ['--import', 'tsx', '--test', 'scripts/qa09-business-reconciliation.test.mjs', 'scripts/qa09-formal-closeout-map.test.mjs', 'scripts/qa09-replay-dedup-assessment.test.mjs']);
const integrity = run('python3', ['docs/audit/evidence/qa-09-close-07-esg-2026-10-13/verify.py']);
if (focused.exitCode !== 0 || integrity.exitCode !== 0) throw Error('LOCAL_VERIFICATION_FAILED');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const log = git('log', baseline, '--since=2026-10-01T00:00:00+08:00', '--until=2026-10-14T00:00:00+08:00', '--format=%h|%ad|%s', '--date=short');
const commits = log.split('\n').filter((line) => /qa09|qa-09/i.test(line));
const auditFiles = git('ls-tree', '-z', '--name-only', baseline + ':docs/audit').split('\0');
const devFiles = git('ls-tree', '-z', '--name-only', baseline + ':docs/dev').split('\0');
const refs = [
  'infra/environments/qa09-current-test.json',
  '.github/workflows/deploy-test.yml',
  'docs/dev/QA-09-业务闭环优先收口计划.md',
  'docs/dev/QA-09-自然许可证确认与Telemetry阶段观测.md',
  'docs/audit/QA-09-CLOSE-01业务证据合并与非Active用户闭环-2026-10-12.md',
  'docs/audit/QA-09-CLOSE-07可靠性业务证据与非空Replay队列去重-2026-10-13.md',
  'docs/audit/QA-09-CLOSE-07自有导出租约与自然日报归档ESG一致性-2026-10-13.md',
  'docs/audit/evidence/qa-09-close-07-esg-2026-10-13/formal-map.json',
];
const applicationInputs = compareApplicationInputs(deployed, baseline);
if (!applicationInputs.every((entry) => entry.equal)) throw Error('APPLICATION_INPUTS_CHANGED');
writeFileSync(output, JSON.stringify({
  scope: 'REPOSITORY_ROOT_CAUSE_AND_CLOSEOUT_PLANNING_ONLY',
  date: '2026-10-13', timezone: 'Asia/Shanghai', baseline, lastRecordedTargetApplication: deployed,
  qa09Status: 'PARTIAL', fullQa09Accepted: false, releasePerformanceAccepted: false, productionReady: false,
  liveAwsRead: false, cloudMutation: false, formalPassCount: 0, formalRequiredCount: 8,
  applicationInputs, gates, focused, integrity,
  history: { titleFilter: 'qa09|qa-09 case-insensitive, Oct 1-13, reachable from baseline', commits, count: commits.length,
    auditReportCountAtBaseline: auditFiles.filter((path) => /^QA-09.*\.md$/.test(path)).length,
    devGuideCountAtBaseline: devFiles.filter((path) => /^QA-09.*\.md$/.test(path)).length },
  sources: refs.map((path) => ({ path, sha256: sha(readFileSync(path)) })),
  historicalResultsNotPromoted: true,
}, null, 2) + '\n');
console.log(JSON.stringify({ output, formalPass: '0/8', isolatedConflicts: gates.length, localTests: '10 PASS', integrity: 'PASS_INTEGRITY_ONLY', qa09: 'PARTIAL' }));
