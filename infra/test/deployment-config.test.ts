import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { assert, test } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { createDeploymentSynthesizer, serviceRoleBoundary } from '../src/deployment.js';
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
  enableAdminBootstrapRunner: 'true',
  enableScheduledWorkers: 'false',
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
      synthesizer: createDeploymentSynthesizer(config),
      permissionsBoundary: serviceRoleBoundary(),
    }),
  );
  assert.isEmpty(
    Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (value) => value.Properties.FunctionName === 'fdp-test-business-notifier',
    ),
  );
  assert.isFalse(JSON.stringify(template.toJSON()).includes('ses:SendEmail'));
  assert.isFalse(JSON.stringify(template.toJSON()).includes('BUSINESS_EMAIL_FROM'));
  assert.isFalse(JSON.stringify(template.toJSON()).includes('BUSINESS_WEBHOOK_ALLOWED_HOSTS'));
  assert.isEmpty(
    Object.values(template.findResources('AWS::S3::Bucket')).filter(
      (value) => value.Properties.BucketName === 'example-controlled-truststore',
    ),
  );
  assert.isFalse(JSON.stringify(template.toJSON()).includes('fdp-test-mtls-truststore-065986019555'));
  assert.isEmpty(template.findResources('AWS::ApiGateway::Account'));
  const rules = Object.values(template.findResources('AWS::Events::Rule'));
  assert.isAbove(rules.length, 0);
  for (const rule of rules) assert.equal(rule.Properties.State, 'DISABLED');
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    DBInstanceClass: 'db.t4g.micro',
    AllocatedStorage: '20',
    BackupRetentionPeriod: 0,
    DeletionProtection: false,
  });
  template.hasResourceProperties('AWS::CodeBuild::Project', {
    Name: 'fdp-test-migration-runner',
    ServiceRole: { 'Fn::GetAtt': [Match.stringLikeRegexp('MigrationRunnerServiceRole'), 'Arn'] },
  });
  template.hasResourceProperties('AWS::CodeBuild::Project', {
    Name: 'fdp-test-admin-bootstrap-runner',
    ServiceRole: { 'Fn::GetAtt': [Match.stringLikeRegexp('AdminBootstrapRunnerServiceRole'), 'Arn'] },
    ConcurrentBuildLimit: 1,
    AutoRetryLimit: 0,
    TimeoutInMinutes: 10,
    Source: Match.objectLike({ Type: 'S3' }),
    Environment: Match.objectLike({
      EnvironmentVariables: Match.arrayWith([
        { Name: 'FDP_EXPECTED_SOURCE_COMMIT', Type: 'PLAINTEXT', Value: 'NOT_APPROVED' },
        { Name: 'FDP_BOOTSTRAP_EMAIL', Type: 'PLAINTEXT', Value: 'NOT_APPROVED' },
        { Name: 'FDP_BOOTSTRAP_DISPLAY_NAME', Type: 'PLAINTEXT', Value: 'NOT_APPROVED' },
        { Name: 'FDP_BOOTSTRAP_CONFIRMATION', Type: 'PLAINTEXT', Value: 'NOT_APPROVED' },
      ]),
    }),
  });
  template.hasResourceProperties('AWS::Amplify::App', {
    Name: 'fdp-test-admin-web',
    Platform: 'WEB',
    EnvironmentVariables: Match.arrayWith([
      { Name: 'AMPLIFY_MONOREPO_APP_ROOT', Value: 'apps/admin-web' },
      { Name: 'VITE_ADMIN_API_BASE_URL', Value: 'https://api.bio-nexa.com/api/v1' },
      { Name: 'VITE_COGNITO_REGION', Value: 'ap-southeast-1' },
    ]),
  });
  template.hasResourceProperties('AWS::Amplify::Branch', {
    BranchName: 'main',
    EnableAutoBuild: true,
    EnablePullRequestPreview: false,
    Framework: 'React',
    Stage: 'DEVELOPMENT',
  });
  template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
    ManagedPolicyName: 'FDP-MigrationRunnerBoundary',
  });
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: { 'Fn::Join': Match.anyValue() },
  });
  for (const [logicalId, role] of Object.entries(template.findResources('AWS::IAM::Role'))) {
    if (logicalId.startsWith('MigrationRunnerServiceRole')) {
      assert.match(role.Properties.PermissionsBoundary.Ref, /^MigrationRunnerBoundary/u);
    } else if (logicalId.startsWith('AdminBootstrapRunnerServiceRole')) {
      assert.include(JSON.stringify(role.Properties.PermissionsBoundary), 'FDP-MigrationRunnerBoundary');
    } else {
      assert.deepEqual(role.Properties.PermissionsBoundary, {
        'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::065986019555:policy/FDP-ServiceBoundary']],
      });
    }
  }
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
  const projects = Object.values(template.findResources('AWS::CodeBuild::Project'));
  const project = projects.find((value) => value.Properties.Name === 'fdp-test-migration-runner')?.Properties;
  const adminBootstrapProject = projects.find(
    (value) => value.Properties.Name === 'fdp-test-admin-bootstrap-runner',
  )?.Properties;
  assert.isDefined(project);
  assert.isDefined(adminBootstrapProject);
  assert.include(JSON.stringify(adminBootstrapProject.Source.Location), 'bootstrap/source.zip');
  assert.deepEqual(broadAllowViolations(template.toJSON()), []);
  const statements = collectPolicyStatements(template.toJSON()).filter(
    (value) =>
      (value.logicalId.startsWith('MigrationRunner') || value.logicalId.startsWith('AdminBootstrapRunner')) &&
      !value.logicalId.startsWith('MigrationRunnerBoundary') &&
      !value.logicalId.startsWith('AdminBootstrapRunnerBoundary'),
  );
  const secretReads = statements.filter((value) =>
    JSON.stringify(value.statement.Action).includes('secretsmanager:GetSecretValue'),
  );
  assert.isAbove(secretReads.length, 0);
  for (const value of secretReads) {
    assert.include(JSON.stringify(value.statement.Resource), 'DatabaseSecret');
    assert.notEqual(value.statement.Resource, '*');
  }
  const decrypts = statements.filter((value) => JSON.stringify(value.statement.Action).includes('kms:Decrypt'));
  assert.isAbove(decrypts.length, 0);
  for (const value of decrypts) {
    assert.include(JSON.stringify(value.statement.Resource), 'DataKey');
    assert.notEqual(value.statement.Resource, '*');
  }
  assert.equal(project.ConcurrentBuildLimit, 1);
  assert.equal(project.AutoRetryLimit, 0);
  assert.equal(project.TimeoutInMinutes, 20);
  assert.equal(project.Source.Type, 'S3');
  assert.isDefined(project.VpcConfig);
  assert.include(project.Source.BuildSpec, 'check-migration-source.mjs');
  assert.include(project.Source.BuildSpec, 'run-database-migrations.mjs');
  assert.equal(adminBootstrapProject.ConcurrentBuildLimit, 1);
  assert.equal(adminBootstrapProject.AutoRetryLimit, 0);
  assert.equal(adminBootstrapProject.TimeoutInMinutes, 10);
  assert.isDefined(adminBootstrapProject.VpcConfig);
  assert.include(adminBootstrapProject.Source.BuildSpec, 'check-admin-bootstrap-source.mjs');
  assert.include(adminBootstrapProject.Source.BuildSpec, 'run-admin-bootstrap.mjs');
  const responses = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse'));
  for (const value of responses)
    assert.equal(
      value.Properties.ResponseParameters['gatewayresponse.header.Access-Control-Allow-Origin'],
      "'https://admin.bio-nexa.com'",
    );
  assert.equal(template.findOutputs('*').DeviceApiUrl.Value, 'https://device-api.bio-nexa.com/');
  assert.equal(template.findOutputs('*').AdminApiUrl.Value, 'https://api.bio-nexa.com/api/v1/');
  assert.equal(template.findOutputs('*').OnboardingApiUrl.Value, 'https://onboard-api.bio-nexa.com/');
}, 30000);

test('preconnect context is default off and restricted to test capacity with explicit engine', () => {
  assert.isFalse(resolveConfig(new App({ context })).enableQa09AuthenticatedPreconnect);
  const enabled = {
    ...context,
    enableRequestObservability: true,
    enableQa09Capacity: true,
    enableQa09EngineCpuDiagnosis: true,
    enableQa09AuthenticatedPreconnect: true,
  };
  assert.isTrue(resolveConfig(new App({ context: enabled })).enableQa09AuthenticatedPreconnect);
  for (const patch of [
    { envName: 'prod' },
    { enableQa09Capacity: false },
    { enableQa09EngineCpuDiagnosis: false },
    { enableQa09AuthenticatedPreconnect: 'yes' },
  ])
    assert.throws(() => resolveConfig(new App({ context: { ...enabled, ...patch } })));
});

test('contract detail context defaults off, accepts only strict booleans and requires existing preconnect guards', () => {
  assert.isFalse(resolveConfig(new App({ context })).enableQa09ContractLoadDetail);
  const enabled = {
    ...context,
    enableRequestObservability: true,
    enableQa09Capacity: true,
    enableQa09EngineCpuDiagnosis: true,
    enableQa09AuthenticatedPreconnect: true,
    enableQa09ContractLoadDetail: true,
  };
  assert.isTrue(resolveConfig(new App({ context: enabled })).enableQa09ContractLoadDetail);
  for (const patch of [
    { enableQa09ContractLoadDetail: 'yes' },
    { enableQa09AuthenticatedPreconnect: false },
    { enableQa09EngineCpuDiagnosis: false },
    { enableQa09Capacity: false },
    { envName: 'prod' },
  ])
    assert.throws(() => resolveConfig(new App({ context: { ...enabled, ...patch } })));
});

test('public context defaults off and requires strict detail and all existing budget guards', () => {
  assert.isFalse(resolveConfig(new App({ context })).enableQa09ContractPublicBoundaries);
  const enabled = {
    ...context,
    enableRequestObservability: true,
    enableQa09Capacity: true,
    enableQa09EngineCpuDiagnosis: true,
    enableQa09AuthenticatedPreconnect: true,
    enableQa09ContractLoadDetail: true,
    enableQa09ContractPublicBoundaries: true,
  };
  assert.isTrue(resolveConfig(new App({ context: enabled })).enableQa09ContractPublicBoundaries);
  for (const patch of [
    { enableQa09ContractPublicBoundaries: 'yes' },
    { enableQa09ContractLoadDetail: false },
    { enableQa09AuthenticatedPreconnect: false },
    { enableQa09Capacity: false },
    { enableQa09EngineCpuDiagnosis: false },
    { envName: 'prod' },
  ])
    assert.throws(() => resolveConfig(new App({ context: { ...enabled, ...patch } })));
});
