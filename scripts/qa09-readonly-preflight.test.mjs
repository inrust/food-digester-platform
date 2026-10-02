import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardIdentity, guardStack, assess, errorCategory, TARGET, ROLES } from './run-qa09-readonly-preflight.mjs';
const identity = {
  Account: TARGET.accountId,
  Arn: `arn:aws:sts::${TARGET.accountId}:assumed-role/AWSReservedSSO_FDP-ReadOnlyOps_abc/session`,
};
const stack = {
  StackName: TARGET.stackName,
  StackId: `arn:aws:cloudformation:${TARGET.region}:${TARGET.accountId}:stack/${TARGET.stackName}/id`,
  Tags: [
    { Key: 'fdp:env', Value: 'test' },
    { Key: 'fdp:project', Value: 'food-digester-platform' },
  ],
};
test('only exact test account and readonly role accepted', () => {
  guardIdentity(identity);
  for (const change of [
    { Account: '999999999999' },
    { Arn: identity.Arn.replace('ReadOnlyOps', 'AppDeploy') },
    { Arn: identity.Arn.replace(TARGET.accountId, '999999999999') },
  ])
    assert.throws(() => guardIdentity({ ...identity, ...change }));
});
test('stack identity, region, project and test tag fail closed', () => {
  guardStack(stack);
  for (const change of [
    { StackName: 'production' },
    { StackId: stack.StackId.replace(TARGET.region, 'us-east-1') },
    { Tags: [] },
    { Tags: stack.Tags.slice(0, 1) },
  ])
    assert.throws(() => guardStack({ ...stack, ...change }));
});
test('permission denial is unverified, never classified as absent', () => {
  assert.equal(errorCategory({ stderr: 'AccessDeniedException opaque-token' }), 'AccessDeniedException');
  assert.equal(errorCategory({ stderr: 'ResourceNotFoundException' }), 'ResourceNotFoundException');
  assert.equal(errorCategory({ stderr: 'SSO token refresh expired' }), 'SSO_INVALID_OR_EXPIRED');
});
test('metadata health never promotes missing business evidence to AWS PASS', () => {
  const sha = 'a'.repeat(40),
    observations = [
      ...['resources', 'rds', 'cognito-pool', 'cognito-client', 'cognito-users'].map((id) => ({
        id,
        status: 'OBSERVED',
        data: [],
      })),
      { id: 'stack', status: 'OBSERVED', data: { Status: 'UPDATE_COMPLETE' } },
      ...ROLES.map((r) => ({ id: `members-${r}`, status: 'OBSERVED', data: [{ enabled: true, status: 'CONFIRMED' }] })),
      { id: 'amplify-jobs', status: 'OBSERVED', data: [{ status: 'SUCCEED', commitId: sha }] },
      {
        id: 'github-deploy-runs',
        status: 'OBSERVED',
        data: [{ status: 'completed', conclusion: 'success', headSha: sha }],
      },
    ];
  const result = assess(observations, sha);
  assert.equal(result.readinessGate, 'BLOCKED');
  assert.equal(result.awsAcceptanceGate, 'NOT RUN / NO RECEIPT');
  assert.ok(result.blockers.some((x) => x.includes('database')));
});
test('five groups with unconfirmed or disabled users do not prove usable identities', () => {
  const result = assess(
    ROLES.map((r) => ({
      id: `members-${r}`,
      status: 'OBSERVED',
      data: [
        { enabled: false, status: 'CONFIRMED' },
        { enabled: true, status: 'FORCE_CHANGE_PASSWORD' },
      ],
    })),
    'a'.repeat(40),
  );
  for (const role of ROLES) assert.ok(result.blockers.includes(`No enabled CONFIRMED Cognito identity in ${role}`));
});
test('missing target receipts and version mismatch remain blockers', () => {
  const result = assess(
    [
      { id: 'gate-example', exitCode: 1, status: 'NOT RUN / NO RECEIPT' },
      { id: 'amplify-jobs', status: 'OBSERVED', data: [{ status: 'SUCCEED', commitId: 'b'.repeat(40) }] },
    ],
    'a'.repeat(40),
  );
  assert.ok(result.blockers.some((x) => x.includes('gate-example')));
  assert.ok(result.blockers.some((x) => x.includes('Amplify')));
});

test('existing test environment requires neither new account nor stack and retains real-response/cleanup boundaries', async () => {
  const { CURRENT_TEST_CONFIG, validateCurrentEnvironment } = await import('./qa09-current-environment.mjs');
  validateCurrentEnvironment(CURRENT_TEST_CONFIG);
  for (const change of [
    { createSeparateEnvironment: true },
    { accountId: '999999999999' },
    { syntheticResponsesAllowed: true },
    { dataSeparation: 'NONE' },
    { environment: 'production' },
  ])
    assert.throws(() => validateCurrentEnvironment({ ...CURRENT_TEST_CONFIG, ...change }));
  assert.throws(() =>
    validateCurrentEnvironment({
      ...CURRENT_TEST_CONFIG,
      authorization: { ...CURRENT_TEST_CONFIG.authorization, cloudDeployment: true },
    }),
  );
});
