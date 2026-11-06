import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { AppDependenciesStack } from '../src/stacks/app-dependencies-stack.js';
let resources: Record<string, any>;
beforeAll(() => {
  const app = new App();
  const stack = new AppDependenciesStack(app, 'LiveImageTest', {
    config: { envName: 'test', allowInsecureDeviceEndpointForLocal: true, adminWebOrigin: 'https://admin.example.com' },
  });
  resources = Template.fromStack(stack).toJSON().Resources;
}, 60000);
test('permanent encrypted CONTROL and encrypted TTL payload table are separate', () => {
  const tables = Object.values(resources).filter((r) => r.Type === 'AWS::DynamoDB::Table');
  expect(tables).toHaveLength(2);
  const control = tables.find((r) => r.Properties.TableName.endsWith('live-image-control'))!;
  const payload = tables.find((r) => r.Properties.TableName.endsWith('live-image-payload'))!;
  expect(control.DeletionPolicy).toBe('Retain');
  expect(control.Properties).not.toHaveProperty('TimeToLiveSpecification');
  expect(control.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
  expect(payload.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
  for (const table of tables) {
    expect(table.Properties.SSESpecification.SSEEnabled).toBe(true);
    expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
  }
});
test('every DB Lambda receives both table names and CONTROL-only fencing IAM; only API roles receive payload access', () => {
  const functions = Object.entries(resources).filter(
    ([, r]) => r.Type === 'AWS::Lambda::Function' && r.Properties.Environment?.Variables?.DB_SECRET_ARN,
  );
  expect(functions).toHaveLength(18);
  for (const [id, fn] of functions) {
    const env = fn.Properties.Environment.Variables;
    expect(env.LIVE_IMAGE_CONTROL_TABLE).toBeDefined();
    expect(env.LIVE_IMAGE_PAYLOAD_TABLE).toBeDefined();
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    const statements = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((role: any) => role.Ref === roleId))
      .flatMap((r) => r.Properties.PolicyDocument.Statement);
    const dynamo = statements.filter((s: any) => JSON.stringify(s.Action).includes('dynamodb:'));
    expect(
      dynamo.some(
        (s: any) =>
          JSON.stringify(s.Resource).includes('LiveImageControl') &&
          JSON.stringify(s.Action).includes('dynamodb:PutItem'),
      ),
    ).toBe(true);
    const payload = dynamo.filter((s: any) => JSON.stringify(s.Resource).includes('LiveImagePayload'));
    if (id.startsWith('ApiFn')) {
      expect(payload).toHaveLength(1);
      expect([payload[0].Action].flat()).toEqual(['dynamodb:GetItem']);
    } else if (id.startsWith('DeviceApiFn')) {
      expect(payload).toHaveLength(1);
      expect([payload[0].Action].flat()).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem']));
    } else expect(payload).toEqual([]);
  }
});
test('private Lambda subnets have a DynamoDB gateway endpoint', () => {
  const endpoints = Object.values(resources).filter((r) => r.Type === 'AWS::EC2::VPCEndpoint');
  expect(
    endpoints.some(
      (r) =>
        JSON.stringify(r.Properties.ServiceName).includes('dynamodb') &&
        r.Properties.VpcEndpointType === 'Gateway' &&
        r.Properties.RouteTableIds.length === 2,
    ),
  ).toBe(true);
});
test('all deployed Prisma entry factories use the authority wrapper, including preconnect', () => {
  for (const dir of ['cloud-api', 'ingestion-worker', 'summary-worker']) {
    const root = new URL(`../../apps/${dir}/src/runtime/`, import.meta.url);
    for (const name of readdirSync(root).filter((name) => name.endsWith('entry.ts'))) {
      const source = readFileSync(new URL(name, root), 'utf8');
      expect(source).not.toMatch(/\bcreatePrismaClient\b/);
      if (source.includes('createAdminPreconnectCandidate'))
        expect(source).toContain('withLiveImageAuthorityFromEnv(runtimeClient.client)');
    }
  }
});
