import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assert, test } from 'vitest';
import {
  AdminBootstrapExecutionStack,
  adminBootstrapConfirmation,
} from '../src/stacks/admin-bootstrap-execution-stack.js';

test('admin bootstrap execution binds exact source, email and confirmation to one project', () => {
  const app = new App();
  const email = 'first.admin@example.com';
  const stack = new AdminBootstrapExecutionStack(app, 'AdminBootstrapExecutionTest', {
    env: { account: '065986019555', region: 'ap-southeast-1' },
    sourceVersion: 'approved-s3-version',
    sourceCommit: 'a'.repeat(40),
    adminEmail: email,
    adminDisplayName: 'First Admin',
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'fdp-test-admin-bootstrap-trigger',
    Timeout: 60,
  });
  template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
    ProjectName: 'fdp-test-admin-bootstrap-runner',
    SourceVersion: 'approved-s3-version',
    SourceCommit: 'a'.repeat(40),
    AdminEmail: email,
    AdminDisplayName: 'First Admin',
    Confirmation: adminBootstrapConfirmation(email),
  });
  const rendered = JSON.stringify(template.toJSON());
  assert.include(rendered, 'project/fdp-test-admin-bootstrap-runner');
  assert.include(rendered, 'FDP_BOOTSTRAP_CONFIRMATION');
  assert.notInclude(rendered, 'PASSWORD');
});

test('admin bootstrap execution rejects incomplete or invalid approval inputs', () => {
  const app = new App();
  assert.throws(
    () =>
      new AdminBootstrapExecutionStack(app, 'InvalidSource', {
        sourceVersion: '',
        sourceCommit: 'main',
        adminEmail: 'first.admin@example.com',
        adminDisplayName: 'First Admin',
      }),
  );
  assert.throws(
    () =>
      new AdminBootstrapExecutionStack(app, 'InvalidEmail', {
        sourceVersion: 'version',
        sourceCommit: 'a'.repeat(40),
        adminEmail: 'invalid',
        adminDisplayName: 'First Admin',
      }),
  );
});
