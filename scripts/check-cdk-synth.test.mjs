import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCdkWarnings, findDeliveredLambdaAssetErrors } from './check-cdk-synth.mjs';

test('CDK WARNING 与规则校验编号会触发 Gate', () => {
  const warnings = findCdkWarnings('WARNING: runtime is deprecated\n[Warning at /Stack/Role] F3031 bad value');
  assert.equal(warnings.length, 2);
});

test('正常 synth 输出不会误报', () => {
  assert.deepEqual(
    findCdkWarnings(
      'Successfully synthesized to cdk.out\n...d79f8964007d101ec11e3bb1da51843a-building/index.mjs  5.5mb ⚠️',
    ),
    [],
  );
});

test('已交付 Lambda 缺失或回退到内联 501 占位时 Gate 失败', () => {
  const template = {
    Resources: {
      DeviceApiFnABC: { Type: 'AWS::Lambda::Function', Properties: { Code: { ZipFile: 'return 501' } } },
    },
  };
  const errors = findDeliveredLambdaAssetErrors([template], ['DeviceApiFn', 'OnboardingApiFn']);
  assert.ok(errors.some((error) => /DeviceApiFnABC/u.test(error) && /占位/u.test(error)));
  assert.ok(errors.some((error) => /OnboardingApiFn/u.test(error) && /缺失/u.test(error)));
});

test('已交付 Lambda 使用 S3 asset 时 Gate 通过', () => {
  const template = {
    Resources: {
      DeviceApiFnABC: { Type: 'AWS::Lambda::Function', Properties: { Code: { S3Bucket: 'assets', S3Key: 'x.zip' } } },
    },
  };
  assert.deepEqual(findDeliveredLambdaAssetErrors([template], ['DeviceApiFn']), []);
});
