import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assert, test } from 'vitest';
import { MigrationExecutionStack } from '../src/stacks/migration-execution-stack.js';

test('migration execution is exact-version, exact-commit, and project-scoped', () => {
  const app = new App();
  const stack = new MigrationExecutionStack(app, 'MigrationExecutionTest', {
    env: { account: '065986019555', region: 'ap-southeast-1' },
    sourceVersion: 'approved-s3-version',
    sourceCommit: 'a'.repeat(40),
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'fdp-test-migration-trigger',
    Timeout: 60,
  });
  template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
    ProjectName: 'fdp-test-migration-runner',
    SourceVersion: 'approved-s3-version',
    SourceCommit: 'a'.repeat(40),
  });
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  assert.equal(roles.length, 1);
  assert.include(JSON.stringify(roles[0].Properties.PermissionsBoundary), 'FDP-MigrationRunnerBoundary');
  assert.include(JSON.stringify(template.toJSON()), 'codebuild:StartBuild');
  assert.include(JSON.stringify(template.toJSON()), 'project/fdp-test-migration-runner');
});

test('migration execution rejects incomplete approval binding', () => {
  const app = new App();
  assert.throws(
    () =>
      new MigrationExecutionStack(app, 'InvalidMigrationExecution', {
        sourceVersion: '',
        sourceCommit: 'not-a-sha',
      }),
  );
});
