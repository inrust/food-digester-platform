#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function findCdkWarnings(output) {
  return output.split(/\r?\n/u).filter((line) => /(?:\bWARNING\b|\[Warning at |\bF\d{4}\b)/iu.test(line));
}

export function checkCdkSynth(root = process.cwd()) {
  const executable = resolve(root, 'infra/node_modules/.bin/cdk');
  const run = spawnSync(executable, ['synth', '--quiet'], { cwd: resolve(root, 'infra'), encoding: 'utf8' });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  if (run.status !== 0) throw new Error(`cdk synth 失败（exit ${run.status ?? 'unknown'}）\n${output}`);
  const warnings = findCdkWarnings(output);
  if (warnings.length > 0) throw new Error(`cdk synth 存在警告：\n${warnings.join('\n')}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  checkCdkSynth(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('CDK synth 无 warning');
}
