import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, test } from 'vitest';
import { AppDependenciesStack } from '../src/stacks/app-dependencies-stack.js';
import { databaseCapacity } from '../src/database-capacity.js';

test('IMG-12 minute worker has a real asset, separate schedule/DLQ and bounded DB-only permissions', () => {
  const app = new App();
  const stack = new AppDependenciesStack(app, 'EvidenceWiring', {
    config: {
      envName: 'test',
      allowInsecureDeviceEndpointForLocal: true,
      enableScheduledWorkers: true,
      enableQa09Capacity: true,
      enableRequestObservability: true,
    },
  });
  const resources = Template.fromStack(stack).toJSON().Resources as Record<string, any>;
  const fn = Object.values(resources).find(
    (r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === 'fdp-test-media-evidence',
  );
  expect(fn).toBeDefined();
  expect(fn.Properties.Code.S3Key).toBeDefined();
  expect(fn.Properties.Code.ZipFile).toBeUndefined();
  expect(fn.Properties).toMatchObject({ Timeout: 60, ReservedConcurrentExecutions: 1 });
  expect(fn.Properties.Environment.Variables).toMatchObject({ FDP_DB_POOL_MAX: '1' });
  expect(fn.Properties.Environment.Variables.DB_SECRET_ARN).toBeDefined();
  const rule = Object.values(resources).find(
    (r) => r.Type === 'AWS::Events::Rule' && r.Properties.Name === 'fdp-test-media-evidence',
  );
  expect(rule.Properties).toMatchObject({ ScheduleExpression: 'rate(1 minute)', State: 'ENABLED' });
  expect(rule.Properties.Targets[0]).toMatchObject({
    RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
  });
  expect(rule.Properties.Targets[0].DeadLetterConfig.Arn).toBeDefined();
  const dlq = Object.values(resources).find(
    (r) => r.Type === 'AWS::SQS::Queue' && r.Properties.QueueName === 'fdp-test-media-evidence-dlq',
  );
  expect(dlq.Properties.KmsMasterKeyId).toBeDefined();
  expect(dlq.Properties.MessageRetentionPeriod).toBe(1209600);
  const roleId = fn.Properties.Role['Fn::GetAtt'][0];
  const statements = Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((ref: any) => ref.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement);
  const actions = statements.flatMap((s: any) => [s.Action].flat());
  expect(actions).toContain('secretsmanager:GetSecretValue');
  expect(actions.some((a: string) => /^(iot:|s3:|sqs:)/.test(a))).toBe(false);
  expect(statements.filter((s: any) => JSON.stringify(s.Resource).includes('LiveImagePayload'))).toHaveLength(0);
  expect(databaseCapacity(true, true)).toMatchObject({ steadyConnections: 46, required: 64, headroom: 6 });
}, 60000);
