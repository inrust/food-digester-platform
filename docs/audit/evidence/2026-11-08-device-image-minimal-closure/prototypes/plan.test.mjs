import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cloudAdmission, CANDIDATE } from '../../../../../scripts/device-image-target-package.mjs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url));
const load = (p) => JSON.parse(read(p));
const control = 'arn:aws:dynamodb:ap-southeast-1:065986019555:table/fdp-test-live-image-control';
const statements = (name) => load('iam/' + name + '.template.json').Statement;
const actions = (s) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
test('phase A grants metadata reads but cannot put CONTROL despite the boundary ceiling', () => {
  const phase = statements('writer-phase-a');
  assert.ok(
    phase.some((s) => s.Effect === 'Allow' && actions(s).includes('dynamodb:GetItem') && s.Resource === control),
  );
  assert.ok(!phase.some((s) => s.Effect === 'Allow' && actions(s).includes('dynamodb:PutItem')));
  assert.ok(statements('writer-boundary').some((s) => s.Effect === 'Allow' && actions(s).includes('dynamodb:PutItem')));
});
test('phase B requires one actual server UUID partition, not serial prefix or wildcard', () => {
  const put = statements('writer-phase-b').find((s) => s.Sid === 'PutOnlyApprovedServerAssignedDevice');
  assert.deepEqual(put.Action, ['dynamodb:PutItem']);
  assert.equal(put.Resource, control);
  assert.deepEqual(put.Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys'], [
    'DEVICE#{{BOUND_DEVICE_UUID}}',
  ]);
  assert.equal(put.Condition.Null['dynamodb:LeadingKeys'], 'false');
  assert.ok(!put.Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys'][0].includes('img21-'));
});
for (const name of ['writer-phase-a', 'writer-phase-b', 'writer-boundary', 'verifier', 'verifier-boundary'])
  test(`${name} has no image payload access or wildcard data authority`, () => {
    for (const s of statements(name).filter((s) => s.Effect === 'Allow')) {
      assert.ok(!JSON.stringify(s.Resource).includes('live-image-payload'));
      assert.ok(
        !actions(s).some(
          (a) =>
            a.startsWith('iam:') ||
            a === 'sts:AssumeRole' ||
            a === 'dynamodb:*' ||
            a === 'cognito-idp:*' ||
            a.startsWith('iot:') ||
            a === 's3:*',
        ),
      );
      if (s.Resource === '*')
        assert.ok(
          actions(s).every((a) => a.startsWith('ec2:')),
          'Only documented VPC ENI exception may use Resource *',
        );
    }
  });
test('verifier reads one existing license secret through its own role and has no writer/ENI privileges', () => {
  const s = statements('verifier');
  const secret = s.find((p) => p.Sid === 'ReadOneSecret');
  assert.match(secret.Resource, /fdp-test-license-signing-key-OVgupB$/u);
  assert.deepEqual(secret.Action, ['secretsmanager:GetSecretValue']);
  assert.ok(
    s.every((p) =>
      actions(p).every((a) => !a.startsWith('ec2:') && !a.startsWith('dynamodb:') && !a.startsWith('cognito-idp:')),
    ),
  );
  const kms = s.find((p) => p.Sid === 'DecryptOneSecretOnlyViaSecretsManager');
  assert.equal(kms.Condition.StringEquals['kms:EncryptionContext:SecretARN'], secret.Resource);
  assert.equal(kms.Condition.StringEquals['kms:ViaService'], 'secretsmanager.ap-southeast-1.amazonaws.com');
});
test('VPC service ENI exception is paired with an explicit deny for writer function code', () => {
  const deny = statements('writer-phase-a').find((s) => s.Sid === 'DenyFunctionCodeEc2Calls');
  assert.equal(deny.Effect, 'Deny');
  assert.equal(deny.Resource, '*');
  assert.match(deny.Condition.ArnEquals['lambda:SourceFunctionArn'], /:function:fdp-test-img21-controlled-writer$/u);
  assert.ok(deny.Action.includes('ec2:DescribeSubnets'));
});
test('operator can only invoke numeric versions in an explicit window, not modify source or pass roles', () => {
  const s = statements('operator-invoke');
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].Action, ['lambda:InvokeFunction']);
  assert.equal(s[0].Resource.length, 2);
  assert.ok(s[0].Resource.every((p) => p.endsWith('_VERSION}}')));
  assert.ok(s[0].Condition.DateLessThan['aws:CurrentTime']);
  assert.ok(s[0].Condition.DateGreaterThanEquals['aws:CurrentTime']);
});
test('all drafts have hashes but are deliberately non-executable and unapproved', () => {
  const manifest = load('draft-manifest.json');
  assert.equal(manifest.executable, false);
  for (const [p, hash] of Object.entries(manifest.files))
    assert.equal(createHash('sha256').update(read(p)).digest('hex'), hash, p);
  const p = load('implementation-plan.json');
  assert.equal(p.deploymentAuthorized, false);
  assert.equal(p.iamChangesAuthorized, false);
  assert.equal(p.realG4Authorized, false);
  assert.equal(p.newResources.newTables, 0);
  assert.equal(p.newResources.newPublicEndpoints, 0);
  assert.deepEqual(
    p.phases.map((phase) => phase.id),
    ['MC01', 'MC02', 'MC03', 'MC04', 'MC05', 'MC06', 'MC07'],
  );
  assert.ok(p.phases.slice(0, 3).every((phase) => phase.status === 'NOT_IMPLEMENTED'));
  assert.ok(p.phases.slice(3).every((phase) => phase.status === 'NOT_RUN'));
});
test('application comparison preserves two SHAs and full-input differences, never claims fresh deployment', () => {
  const v = load('version-analysis.json');
  assert.equal(v.applicationCandidate, CANDIDATE);
  assert.notEqual(v.applicationCandidate, v.observedArtifactRelease);
  assert.equal(v.deliverySourceCount, 1693);
  assert.deepEqual(v.changedDeliverySources, []);
  assert.equal(v.fullVerifySourceCount, 1713);
  assert.ok(v.changedFullVerifyInputs.length > 0);
  assert.ok(v.buildInputTrees.every((t) => t.equal));
  assert.ok(v.lastRetainedApplicationFunctions.every((f) => f.matches));
  assert.equal(v.targetFreshReadsThisTask, 0);
  assert.equal(v.targetDeploymentProvenForCandidate, false);
  assert.equal(v.equivalenceAcceptanceApproved, false);
  assert.equal(v.g4, 'NOT_RUN');
});
test('current active admission still rejects a historical release proof; the proposed mode is not silently enabled', () => {
  const base = new URL('../../2026-11-08-device-image-fixture-execution/', import.meta.url);
  const input = JSON.parse(readFileSync(new URL('inputs.json', base)));
  const fake = {
    mode: 'TARGET_CLOUD',
    profile: input.profile,
    sourceCommit: CANDIDATE,
    protocolDigest: input.protocolDigest,
    runId: input.runId,
    accountId: input.entries.accountId.value,
    region: input.entries.region.value,
    stackName: input.entries.stackName.value,
    inputId: 'deploymentProof',
    passed: true,
    capturedAt: '2026-11-08T12:43:02.308Z',
    details: {
      deployedSourceCommit: '69c76e1dd508bf6e03dd21992194a8280109cd0a',
      versions: {
        adminApi: 'retained',
        deviceApi: 'retained',
        ingestion: 'retained',
        mediaEvidence: 'retained',
        outbox: 'retained',
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(fake));
  input.entries.deploymentProof.value = {
    path: 'memory-proof.json',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const result = cloudAdmission(
    input,
    (p) => (p === 'memory-proof.json' ? bytes : readFileSync(new URL(p, base))),
    Date.parse('2026-11-08T12:44:00Z'),
  );
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.includes('INVALID_TARGET_PROOF:deploymentProof'));
});

test('control-plane delta preserves existing root-role deny and bounds the new namespace independently', () => {
  const delta = statements('deployer-delta');
  for (const kind of ['Writer', 'Verifier']) {
    const allow = delta.find((s) => s.Sid === `CreateBoundIMG21${kind}Role`),
      deny = delta.find((s) => s.Sid === `DenyUnboundedIMG21${kind}Role`);
    assert.match(allow.Resource, /:role\/img21\/fdp-test-img21-/u);
    assert.equal(deny.Resource, allow.Resource);
    assert.equal(
      allow.Condition.StringEquals['iam:PermissionsBoundary'],
      deny.Condition.StringNotEquals['iam:PermissionsBoundary'],
    );
    assert.equal(deny.Effect, 'Deny');
  }
  for (const statement of delta) assert.ok(!JSON.stringify(statement.Resource).includes('*'));
  const old = JSON.parse(
    readFileSync(new URL('../../../../../infra/iam/FDP-DeploymentBoundary.json', import.meta.url)),
  );
  assert.equal(
    old.Statement.find((s) => s.Sid === 'DenyWrongServiceBoundary').Condition.StringNotEquals['iam:PermissionsBoundary']
      .length,
    2,
  );
});

test('every IAM draft is a structured policy, never a filename string or partial object', () => {
  for (const p of Object.keys(load('draft-manifest.json').files).filter((p) => p.startsWith('iam/'))) {
    const v = load(p);
    assert.equal(v.Version, '2012-10-17', p);
    assert.ok(Array.isArray(v.Statement) && v.Statement.length > 0, p);
  }
});
