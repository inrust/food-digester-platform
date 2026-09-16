import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assert, test } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { AppDependenciesStack } from '../src/stacks/app-dependencies-stack.js';
import { broadAllowViolations, collectPolicyStatements } from '../src/template-security.js';

const context = {
  envName: 'test',
  deploymentAccount: '065986019555',
  deploymentRegion: 'ap-southeast-1',
  deviceApiDomainName: 'device-api.bio-nexa.com',
  deviceApiCertificateArn: 'arn:aws:acm:ap-southeast-1:065986019555:certificate/00000000-0000-0000-0000-000000000000',
  deviceApiTruststoreBucketName: 'example-controlled-truststore',
  deviceApiTruststoreVersion: 'approved-version',
  adminWebOrigin: 'https://admin.bio-nexa.com',
  adminApiDomainName: 'api.bio-nexa.com',
  onboardingApiDomainName: 'onboard-api.bio-nexa.com',
  publicApiCertificateArn: 'arn:aws:acm:ap-southeast-1:065986019555:certificate/11111111-1111-1111-1111-111111111111',
  enableMigrationRunner: 'true',
  allowInsecureDeviceEndpointForLocal: 'false',
};
test('real deployment rejects incomplete/cross-account inputs and wildcard origin', () => {
  for (const key of [
    'deviceApiCertificateArn',
    'deviceApiTruststoreBucketName',
    'deviceApiTruststoreVersion',
    'adminWebOrigin',
  ]) {
    assert.throws(() => resolveConfig(new App({ context: { ...context, [key]: undefined } })));
  }
  assert.throws(() =>
    resolveConfig(
      new App({
        context: {
          ...context,
          deviceApiCertificateArn: context.deviceApiCertificateArn.replace('065986019555', '123456789012'),
        },
      }),
    ),
  );
  assert.throws(() => resolveConfig(new App({ context: { ...context, adminWebOrigin: '*' } })));
  assert.throws(() => resolveConfig(new App({ context: { ...context, allowInsecureDeviceEndpointForLocal: true } })));
});
test('deployment template: unauthed OPTIONS only, fixed origin errors, pinned truststore and private one-shot migration', () => {
  const app = new App({ context });
  const config = resolveConfig(app);
  const template = Template.fromStack(
    new AppDependenciesStack(app, 'DeployTest', {
      config,
      env: { account: context.deploymentAccount, region: context.deploymentRegion },
    }),
  );
  const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
  const options = methods.filter((value) => value.Properties.HttpMethod === 'OPTIONS');
  assert.equal(options.length, 2);
  for (const value of options) {
    assert.equal(value.Properties.AuthorizationType, 'NONE');
    assert.isUndefined(value.Properties.AuthorizerId);
  }
  template.resourceCountIs('AWS::ApiGateway::GatewayResponse', 2);
  template.resourceCountIs('AWS::ApiGateway::DomainName', 3);
  template.resourceCountIs('AWS::ApiGateway::BasePathMapping', 3);
  template.hasResourceProperties('AWS::ApiGateway::DomainName', {
    DomainName: 'device-api.bio-nexa.com',
    MutualTlsAuthentication: {
      TruststoreUri: 's3://example-controlled-truststore/truststore/ca-bundle.pem',
      TruststoreVersion: 'approved-version',
    },
  });
  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Name: 'fdp-test-device-api',
    DisableExecuteApiEndpoint: true,
  });
  const project = Object.values(template.findResources('AWS::CodeBuild::Project'))[0].Properties;
  assert.deepEqual(broadAllowViolations(template.toJSON()), []);
  const statements = collectPolicyStatements(template.toJSON()).filter((value) =>
    value.logicalId.startsWith('MigrationRunner'),
  );
  const secretReads = statements.filter((value) =>
    JSON.stringify(value.statement.Action).includes('secretsmanager:GetSecretValue'),
  );
  assert.isAbove(secretReads.length, 0);
  for (const value of secretReads) {
    assert.include(JSON.stringify(value.statement.Resource), 'DatabaseSecret');
    assert.notEqual(value.statement.Resource, '*');
  }
  assert.equal(project.ConcurrentBuildLimit, 1);
  assert.equal(project.AutoRetryLimit, 0);
  assert.equal(project.TimeoutInMinutes, 20);
  assert.equal(project.Source.Type, 'S3');
  assert.isDefined(project.VpcConfig);
  assert.include(project.Source.BuildSpec, 'check-migration-source.mjs');
  assert.include(project.Source.BuildSpec, 'run-database-migrations.mjs');
  const responses = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse'));
  for (const value of responses)
    assert.equal(
      value.Properties.ResponseParameters['gatewayresponse.header.Access-Control-Allow-Origin'],
      "'https://admin.bio-nexa.com'",
    );
  assert.equal(template.findOutputs('*').DeviceApiUrl.Value, 'https://device-api.bio-nexa.com/');
  assert.equal(template.findOutputs('*').AdminApiUrl.Value, 'https://api.bio-nexa.com/');
  assert.equal(template.findOutputs('*').OnboardingApiUrl.Value, 'https://onboard-api.bio-nexa.com/');
}, 30000);
