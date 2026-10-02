import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareProbe } from './prepare-qa09-db-readonly-probe.mjs';
import { RETIREMENT_PROJECT, validateApproval } from './qa09-retire-legacy-onboarding.mjs';
export function prepareRetirement(plan) {
  validateApproval(plan);
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const code = readFileSync('scripts/qa09-retire-legacy-onboarding.mjs'),
    helper = readFileSync('scripts/qa09-db-readonly-probe.mjs');
  const base = prepareProbe();
  const project = base.project;
  project.name = RETIREMENT_PROJECT;
  project.description = 'QA-09 approved snapshot-bound retirement of two historical requests and jobs';
  project.logsConfig.cloudWatchLogs.streamName = 'qa09-legacy-retirement';
  const spec = JSON.parse(project.source.buildspec);
  spec.phases.install.commands = spec.phases.install.commands.filter((c) => !c.startsWith('node -e'));
  spec.phases.install.commands.push(
    `node -e "require('node:fs').writeFileSync('qa09-db-readonly-probe.mjs', Buffer.from('${helper.toString('base64')}', 'base64'))"`,
    `node -e "require('node:fs').writeFileSync('retirement.mjs', Buffer.from('${code.toString('base64')}', 'base64'))"`,
  );
  spec.phases.build.commands = ['cd /tmp/qa09-db-probe', 'node retirement.mjs'];
  project.source.buildspec = JSON.stringify(spec);
  project.environment.environmentVariables = [
    project.environment.environmentVariables[0],
    {
      name: 'QA09_RETIREMENT_APPROVAL_B64',
      type: 'PLAINTEXT',
      value: Buffer.from(JSON.stringify(plan)).toString('base64'),
    },
    { name: 'QA09_RETIREMENT_SHA256', type: 'PLAINTEXT', value: hash(code) },
    { name: 'QA09_QUERY_MODULE_SHA256', type: 'PLAINTEXT', value: hash(helper) },
  ];
  return {
    approval: plan,
    executorSha256: hash(code),
    helperSha256: hash(helper),
    buildspecSha256: hash(project.source.buildspec),
    project,
    request: { projectName: RETIREMENT_PROJECT },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!output) throw Error('APPROVAL_AND_OUTPUT_REQUIRED');
  writeFileSync(output, JSON.stringify(prepareRetirement(JSON.parse(readFileSync(input, 'utf8'))), null, 2) + '\n');
}
