import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert, test } from 'vitest';
import {
  FDP_BOOTSTRAP_QUALIFIER,
  FDP_MIGRATION_RUNNER_BOUNDARY_NAME,
  FDP_SERVICE_BOUNDARY_NAME,
  deploymentRoleName,
} from '../src/deployment.js';

const root = resolve(import.meta.dirname, '..');

test('deployment naming matches the account-specific bootstrap contract', () => {
  assert.equal(FDP_BOOTSTRAP_QUALIFIER, 'fdptest01');
  assert.equal(FDP_SERVICE_BOUNDARY_NAME, 'FDP-ServiceBoundary');
  assert.equal(FDP_MIGRATION_RUNNER_BOUNDARY_NAME, 'FDP-MigrationRunnerBoundary');
  assert.equal(deploymentRoleName('test', 'cdk-deploy-role'), 'fdp-test-cdk-deploy-role');
  const template = readFileSync(resolve(root, 'bootstrap/fdp-test-bootstrap-template.yaml'), 'utf8');
  for (const expected of [
    'Default: fdptest01',
    'Default: FDP-DeploymentBoundary',
    'fdp-test-cdk-deploy-role',
    'fdp-test-cloudformation-execution-role',
    'fdp-test-cdk-file-publishing-role',
    'fdp-test-cdk-image-publishing-role',
    'fdp-test-cdk-lookup-role',
    'FDP-CloudFormationExecutionPolicy',
  ])
    assert.include(template, expected);
  assert.notInclude(template, 'policy/AdministratorAccess');
  assert.equal(template.match(/^ {6}PermissionsBoundary:$/gmu)?.length, 5);
});

test('reviewed IAM documents parse and keep migration execution out of standing access', () => {
  for (const name of [
    'FDP-ServiceBoundary.json',
    'FDP-MigrationRunnerBoundary.json',
    'FDP-DeploymentBoundary.json',
    'FDP-CloudFormationExecutionPolicy.json',
    'FDP-InfraSetup-bootstrap-additions.json',
    'FDP-AppDeploy-additions.json',
    'FDP-MigrationOperator-one-shot.json',
  ])
    JSON.parse(readFileSync(resolve(root, `iam/${name}`), 'utf8'));
  const appDeploy = JSON.parse(readFileSync(resolve(root, 'iam/FDP-AppDeploy-additions.json'), 'utf8'));
  assert.isFalse(
    appDeploy.Statement.some((statement: { Action: string | string[] }) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes('codebuild:StartBuild'),
    ),
  );
  const oneShot = JSON.parse(readFileSync(resolve(root, 'iam/FDP-MigrationOperator-one-shot.json'), 'utf8'));
  assert.isTrue(oneShot.Statement.some((statement: { Sid: string }) => statement.Sid === 'StartApprovedMigration'));
  assert.isTrue(
    oneShot.Statement.some((statement: { Sid: string }) => statement.Sid === 'DenyMigrationBuildspecOverride'),
  );
  assert.isTrue(
    oneShot.Statement.some((statement: { Sid: string }) => statement.Sid === 'DenyUnexpectedMigrationVariables'),
  );
  const migrationBoundary = JSON.parse(
    readFileSync(resolve(root, 'iam/FDP-MigrationRunnerBoundary.json'), 'utf8'),
  );
  const migrationActions = migrationBoundary.Statement.find(
    (statement: { Sid: string }) => statement.Sid === 'AllowMigrationRunner',
  ).Action;
  for (const action of [
    'codebuild:StartBuild',
    'ec2:CreateNetworkInterfacePermission',
    'ec2:DescribeSubnets',
    'ec2:DescribeSecurityGroups',
    'ec2:DescribeDhcpOptions',
    'ec2:DescribeVpcs',
  ])
    assert.include(migrationActions, action);
  for (const name of ['FDP-DeploymentBoundary.json', 'FDP-CloudFormationExecutionPolicy.json']) {
    const policy = JSON.parse(readFileSync(resolve(root, `iam/${name}`), 'utf8'));
    const roleManagement = policy.Statement.find(
      (statement: { Sid: string }) => statement.Sid === 'AllowFDPServiceRoleManagement',
    );
    for (const action of [
      'iam:UpdateRole',
      'iam:GetRolePolicy',
      'iam:ListRolePolicies',
      'iam:ListAttachedRolePolicies',
    ])
      assert.include(roleManagement.Action, action);
    const infrastructure = policy.Statement.find(
      (statement: { Sid: string }) =>
        statement.Sid === 'AllowFDPInfrastructureServices' || statement.Sid === 'AllowFDPStackServices',
    );
    for (const action of ['secretsmanager:GetRandomPassword', 'secretsmanager:UpdateSecret'])
      assert.include(infrastructure.Action, action);
    assert.include(infrastructure.Action, 'secretsmanager:GetSecretValue');
    const migrationBoundaryManagement = policy.Statement.find(
      (statement: { Sid: string }) => statement.Sid === 'ManageMigrationRunnerBoundary',
    );
    assert.include(migrationBoundaryManagement.Action, 'iam:CreatePolicy');
    assert.include(migrationBoundaryManagement.Action, 'iam:DeletePolicy');
    assert.equal(
      migrationBoundaryManagement.Resource,
      'arn:aws:iam::065986019555:policy/FDP-MigrationRunnerBoundary',
    );
    const denySecretRead = policy.Statement.find(
      (statement: { Sid: string }) => statement.Sid === 'DenyNonDatabaseSecretReads',
    );
    assert.equal(denySecretRead.Action, 'secretsmanager:GetSecretValue');
    assert.equal(
      denySecretRead.NotResource,
      'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-rds-credentials-*',
    );
    const denyWrongBoundary = policy.Statement.find(
      (statement: { Sid: string }) => statement.Sid === 'DenyWrongServiceBoundary',
    );
    assert.sameMembers(denyWrongBoundary.Condition.StringNotEquals['iam:PermissionsBoundary'], [
      'arn:aws:iam::065986019555:policy/FDP-ServiceBoundary',
      'arn:aws:iam::065986019555:policy/FDP-MigrationRunnerBoundary',
    ]);
    const serviceLinkedRole = policy.Statement.find(
      (statement: { Sid: string }) => statement.Sid === 'CreateApiGatewayServiceLinkedRole',
    );
    assert.equal(serviceLinkedRole.Action, 'iam:CreateServiceLinkedRole');
    assert.equal(serviceLinkedRole.Condition.StringEquals['iam:AWSServiceName'], 'ops.apigateway.amazonaws.com');
    assert.equal(
      serviceLinkedRole.Resource,
      'arn:aws:iam::065986019555:role/aws-service-role/ops.apigateway.amazonaws.com/AWSServiceRoleForAPIGateway',
    );
    const rdsServiceLinkedRole = policy.Statement.find(
      (statement: { Sid: string }) => statement.Sid === 'CreateRdsServiceLinkedRole',
    );
    assert.equal(rdsServiceLinkedRole.Action, 'iam:CreateServiceLinkedRole');
    assert.equal(rdsServiceLinkedRole.Condition.StringEquals['iam:AWSServiceName'], 'rds.amazonaws.com');
    assert.equal(
      rdsServiceLinkedRole.Resource,
      'arn:aws:iam::065986019555:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS',
    );
  }
});
