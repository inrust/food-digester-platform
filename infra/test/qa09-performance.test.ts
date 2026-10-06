import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assert, test } from 'vitest';
import { AppDependenciesStack } from '../src/stacks/app-dependencies-stack.js';
import { databaseCapacity } from '../src/database-capacity.js';
test('complete capacity budget accounts for pools, worker concurrency, rotation and operations', () => {
  const candidate = databaseCapacity(true, true);
  assert.throws(() => databaseCapacity(false, true), /IMMEDIATE_PUBLISH_REQUIRES_CAPACITY/);
  assert.equal(candidate.steadyConnections, 45);
  assert.equal(candidate.required, 63);
  assert.equal(candidate.headroom, 7);
  assert.equal(candidate.functions.find((f) => f.name === 'api')?.reservedConcurrency, 12);
  assert.equal(candidate.functions.find((f) => f.name === 'command-publisher')?.poolMax, 1);
  assert.equal(databaseCapacity(false, false).required, 80);
});
test('observability and immediate queue synth retain narrow logs and hard DB budgets', () => {
  const app = new App();
  const stack = new AppDependenciesStack(app, 'Qa09Perf', {
    env: { account: '065986019555', region: 'ap-southeast-1' },
    config: {
      envName: 'test',
      allowInsecureDeviceEndpointForLocal: true,
      enableRequestObservability: true,
      enableQa09Capacity: true,
      enableImmediateCommandPublish: true,
      enableQa09EngineCpuDiagnosis: true,
    },
  });
  const template = Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources) as { Type: string; Properties: Record<string, any> }[];
  const functions = resources.filter((r) => r.Type === 'AWS::Lambda::Function');
  const diagnosed = functions.filter(
    (r) => r.Properties.Environment?.Variables.FDP_QA09_ENGINE_CPU_DIAGNOSIS === 'true',
  );
  assert.equal(diagnosed.length, 1);
  assert.equal(diagnosed[0]?.Properties.FunctionName, 'fdp-test-api');
  assert.equal(diagnosed[0]?.Properties.Environment.Variables.FDP_DB_POOL_MAX, '1');
  assert.equal(diagnosed[0]?.Properties.MemorySize, 512);
  assert.equal(diagnosed[0]?.Properties.ReservedConcurrentExecutions, 12);
  const stage = resources.find((r) => r.Type === 'AWS::ApiGateway::Stage' && r.Properties.AccessLogSetting);
  assert.isDefined(stage);
  const fields = JSON.parse(stage!.Properties.AccessLogSetting.Format);
  assert.deepEqual(
    Object.keys(fields).sort(),
    [
      'requestId',
      'extendedRequestId',
      'requestTimeEpoch',
      'resourcePath',
      'httpMethod',
      'status',
      'integrationStatus',
      'functionStatus',
      'integrationRequestId',
      'integrationLatency',
      'responseLatency',
      'errorResponseType',
    ].sort(),
  );
  assert.equal(fields.integrationStatus, '$context.integration.integrationStatus');
  assert.equal(fields.functionStatus, '$context.integration.status');
  assert.isTrue(
    stage!.Properties.MethodSettings.every(
      (x: { DataTraceEnabled?: boolean; LoggingLevel?: string }) =>
        x.DataTraceEnabled !== true && x.LoggingLevel !== 'INFO',
    ),
  );
  const log = resources.find(
    (r) =>
      r.Type === 'AWS::Logs::LogGroup' && r.Properties.LogGroupName === '/aws/apigateway/fdp-test-admin-api-access',
  );
  assert.equal(log?.Properties.RetentionInDays, 7);
  assert.isDefined(log?.Properties.KmsKeyId);
  assert.equal(resources.filter((r) => r.Type === 'AWS::ApiGateway::Account').length, 1);
  const rolePolicy = resources.find(
    (r) => r.Type === 'AWS::IAM::Policy' && r.Properties.PolicyName.startsWith('AdminGatewayLogsRole'),
  );
  const ownLogs = rolePolicy?.Properties.PolicyDocument.Statement.find(
    (s: { Action: string[] }) => Array.isArray(s.Action) && s.Action.includes('logs:GetLogEvents'),
  );
  assert.include(ownLogs.Action, 'logs:CreateLogGroup');
  assert.include(ownLogs.Action, 'logs:FilterLogEvents');
  assert.notInclude(ownLogs.Resource, '*');
  const welcome = rolePolicy?.Properties.PolicyDocument.Statement.find((s: { Resource: unknown }) =>
    JSON.stringify(s.Resource).includes('/aws/apigateway/welcome'),
  );
  assert.equal(welcome.Action, 'logs:CreateLogGroup');
  assert.notInclude(welcome.Resource, '*');
  assert.isUndefined(welcome.Condition);

  const accountResource = Object.values(template.Resources).find(
    (r: any) => r.Type === 'AWS::ApiGateway::Account',
  ) as any;
  assert.isTrue(accountResource.DependsOn.some((id: string) => id.includes('DefaultPolicy')));

  const dataKey = resources.find(
    (r) => r.Type === 'AWS::KMS::Key' && r.Properties.Description?.startsWith('Application data'),
  );
  const queueDecrypt = dataKey?.Properties.KeyPolicy.Statement.find(
    (s: { Sid?: string }) => s.Sid === 'CommandQueueConsumerDecrypt',
  );
  assert.equal(queueDecrypt.Action, 'kms:Decrypt');
  assert.include(
    JSON.stringify(queueDecrypt.Condition.ArnEquals['aws:PrincipalArn']),
    'fdp-test-command-publisher-role',
  );
  assert.equal(queueDecrypt.Condition.StringEquals['kms:ViaService'], 'sqs.ap-southeast-1.amazonaws.com');
  assert.include(
    JSON.stringify(queueDecrypt.Condition.StringEquals['kms:EncryptionContext:aws:sqs:arn']),
    'fdp-test-command-publish',
  );
  assert.notInclude(JSON.stringify(queueDecrypt.Condition), '*');

  const mapping = resources.find(
    (r) =>
      r.Type === 'AWS::Lambda::EventSourceMapping' &&
      JSON.stringify(r.Properties.EventSourceArn).includes('CommandPublishQueue'),
  );
  assert.equal(mapping?.Properties.BatchSize, 1);
  assert.equal(mapping?.Properties.ScalingConfig.MaximumConcurrency, 2);
  const publisher = resources.find(
    (r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === 'fdp-test-command-publisher',
  );
  assert.equal(publisher?.Properties.MemorySize, 512);
  assert.include(mapping?.Properties.FunctionResponseTypes, 'ReportBatchItemFailures');
  assert.isUndefined(mapping?.Properties.MaximumBatchingWindowInSeconds);
  for (const allocation of databaseCapacity(true, true).functions) {
    const fn = resources.find(
      (r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === 'fdp-test-' + allocation.name,
    );
    assert.equal(fn?.Properties.ReservedConcurrentExecutions, allocation.reservedConcurrency);
    assert.equal(fn?.Properties.Environment.Variables.FDP_DB_POOL_MAX, String(allocation.poolMax));
  }
}, 60000);

test('Gateway service-boundary additions allow only required discovery and own-log reads for the exact log role', async () => {
  const { readFileSync } = await import('node:fs');
  const patch = JSON.parse(
    readFileSync(new URL('../iam/QA09-AdminGatewayLogsBoundary-additions.json', import.meta.url), 'utf8'),
  );
  assert.equal(patch.Statement.length, 3);
  for (const row of patch.Statement) {
    assert.equal(
      row.Condition.ArnEquals['aws:PrincipalArn'],
      'arn:aws:iam::065986019555:role/fdp-test-admin-gateway-logs-role',
    );
    assert.isTrue(
      row.Action.every((a: string) =>
        ['logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents'].includes(a),
      ),
    );
  }
  assert.include(JSON.stringify(patch.Statement[1].Resource), '/aws/apigateway/fdp-test-admin-api-access');
  assert.notInclude(JSON.stringify(patch), '/aws/apigateway/welcome');
});
