import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCdkWarnings, findCmdOtaDeliveryErrors, findDeliveredLambdaAssetErrors } from './check-cdk-synth.mjs';

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

test('CMD/OTA 生产接线 Gate 对 Worker/调度任一缺失均失败关闭', () => {
  const errors = findCmdOtaDeliveryErrors([{ Resources: {} }]);
  for (const expected of [
    'commandPublisher',
    'commandTimeout',
    'otaDispatcher',
    'adminApi',
    'deviceApi',
    '每分钟调度',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `应报告 ${expected}: ${errors.join('; ')}`,
    );
  }
});

test('CMD/OTA 生产接线 Gate 对 IoT/S3/KMS 权限缺失失败关闭', () => {
  const fn = (name, role, variables = {}) => ({
    Type: 'AWS::Lambda::Function',
    Properties: {
      FunctionName: `fdp-test-${name}`,
      Role: { 'Fn::GetAtt': [role, 'Arn'] },
      Environment: { Variables: variables },
    },
  });
  const rule = (name) => ({
    Type: 'AWS::Events::Rule',
    Properties: {
      Name: `fdp-test-${name}`,
      ScheduleExpression: 'rate(1 minute)',
      Targets: [{ DeadLetterConfig: { Arn: 'dlq' } }],
    },
  });
  const errors = findCmdOtaDeliveryErrors([
    {
      Resources: {
        CommandRole: { Type: 'AWS::IAM::Role', Properties: {} },
        TimeoutRole: { Type: 'AWS::IAM::Role', Properties: {} },
        OtaRole: { Type: 'AWS::IAM::Role', Properties: {} },
        AdminRole: { Type: 'AWS::IAM::Role', Properties: {} },
        DeviceRole: { Type: 'AWS::IAM::Role', Properties: {} },
        CommandFn: fn('command-publisher', 'CommandRole'),
        TimeoutFn: fn('command-timeout', 'TimeoutRole'),
        OtaFn: fn('ota-dispatcher', 'OtaRole', { DEVICE_API_BASE_URL: 'https://device.example' }),
        AdminFn: fn('api', 'AdminRole'),
        DeviceFn: fn('device-api-handler', 'DeviceRole'),
        CommandRule: rule('command-publisher'),
        TimeoutRule: rule('command-timeout'),
        OtaRule: rule('ota-dispatcher'),
      },
    },
  ]);
  for (const expected of [
    'Command Publisher',
    'OTA Dispatcher',
    'Admin API OTA S3',
    'Admin API KMS',
    'Device API OTA S3',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `应报告 ${expected}: ${errors.join('; ')}`,
    );
  }
});
