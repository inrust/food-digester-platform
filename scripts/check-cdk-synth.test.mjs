import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCdkWarnings } from './check-cdk-synth.mjs';

test('CDK WARNING 与规则校验编号会触发 Gate', () => {
  const warnings = findCdkWarnings('WARNING: runtime is deprecated\n[Warning at /Stack/Role] F3031 bad value');
  assert.equal(warnings.length, 2);
});

test('正常 synth 输出不会误报', () => {
  assert.deepEqual(findCdkWarnings('Successfully synthesized to cdk.out'), []);
});
