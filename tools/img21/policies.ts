import { TARGET, isUuid, requireThat } from './contracts.js';
export type Statement = {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action: string | string[];
  Resource?: string | string[];
  Principal?: unknown;
  Condition?: Record<string, unknown>;
};
export interface Policy {
  Version: '2012-10-17';
  Statement: Statement[];
}
export type Phase = 'A' | 'B';
const policy = (Statement: Statement[]): Policy => ({ Version: '2012-10-17', Statement });
export const functionArn = (kind: 'writer' | 'verifier') =>
  `arn:aws:lambda:${TARGET.region}:${TARGET.accountId}:function:fdp-test-img21-${kind === 'writer' ? 'controlled-writer' : 'license-verifier'}`;
export const roleName = (kind: 'writer' | 'verifier') =>
  `fdp-test-img21-${kind === 'writer' ? 'controlled-writer' : 'license-verifier'}-role`;
export const roleArn = (kind: 'writer' | 'verifier') => `arn:aws:iam::${TARGET.accountId}:role/img21/${roleName(kind)}`;
export const boundaryArn = (kind: 'writer' | 'verifier') =>
  `arn:aws:iam::${TARGET.accountId}:policy/FDP-IMG21-${kind === 'writer' ? 'Writer' : 'Verifier'}Boundary`;
export const CONTROL = `arn:aws:dynamodb:${TARGET.region}:${TARGET.accountId}:table/${TARGET.controlTable}`;
const key = `arn:aws:kms:${TARGET.region}:${TARGET.accountId}:key/22af85c4-76d3-40c9-a849-0621740afe6c`;
const eni = [
  'ec2:CreateNetworkInterface',
  'ec2:DescribeNetworkInterfaces',
  'ec2:DescribeSubnets',
  'ec2:DeleteNetworkInterface',
  'ec2:AssignPrivateIpAddresses',
  'ec2:UnassignPrivateIpAddresses',
];
const logs = (kind: 'writer' | 'verifier'): Statement => ({
  Sid: 'WriteOwnLogs',
  Effect: 'Allow',
  Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
  Resource: `arn:aws:logs:${TARGET.region}:${TARGET.accountId}:log-group:/aws/lambda/fdp-test-img21-${kind === 'writer' ? 'controlled-writer' : 'license-verifier'}:log-stream:*`,
});
const secret = (arn: string): Statement[] => [
  { Sid: 'ReadOneSecret', Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: arn },
  {
    Sid: 'DecryptOneSecretOnlyViaSecretsManager',
    Effect: 'Allow',
    Action: ['kms:Decrypt'],
    Resource: key,
    Condition: {
      StringEquals: {
        'kms:ViaService': `secretsmanager.${TARGET.region}.amazonaws.com`,
        'kms:EncryptionContext:SecretARN': arn,
      },
    },
  },
];
export function writerPolicy(phase: Phase, deviceId?: string): Policy {
  requireThat(phase === 'A' || phase === 'B', 'INVALID_PHASE');
  requireThat(phase === 'B' ? isUuid(deviceId) : deviceId === undefined, 'PHASE_DEVICE_BINDING_REQUIRED');
  return policy([
    ...secret(TARGET.dbSecretArn),
    {
      Sid: 'ReadCognitoOwnedIdentityMetadata',
      Effect: 'Allow',
      Action: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser'],
      Resource: `arn:aws:cognito-idp:${TARGET.region}:${TARGET.accountId}:userpool/${TARGET.poolId}`,
    },
    {
      Sid: 'ReadControlMetadataForExistingActorFence',
      Effect: 'Allow',
      Action: ['dynamodb:GetItem'],
      Resource: CONTROL,
    },
    logs('writer'),
    { Sid: 'AllowLambdaVpcEniManagement', Effect: 'Allow', Action: eni, Resource: '*' },
    {
      Sid: 'DenyFunctionCodeEc2Calls',
      Effect: 'Deny',
      Action: eni,
      Resource: '*',
      Condition: { ArnEquals: { 'lambda:SourceFunctionArn': functionArn('writer') } },
    },
    {
      Sid: 'NeverDeleteControlEpoch',
      Effect: 'Deny',
      Action: ['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
      Resource: CONTROL,
    },
    ...(phase === 'B'
      ? [
          {
            Sid: 'PutOnlyApprovedServerAssignedDevice',
            Effect: 'Allow' as const,
            Action: ['dynamodb:PutItem'],
            Resource: CONTROL,
            Condition: {
              'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`DEVICE#${deviceId}`] },
              Null: { 'dynamodb:LeadingKeys': 'false' },
            },
          },
        ]
      : []),
  ]);
}
export const writerBoundary = () =>
  policy([
    ...writerPolicy('A').Statement,
    { Sid: 'MaximumControlPutCeilingNotAGrant', Effect: 'Allow', Action: ['dynamodb:PutItem'], Resource: CONTROL },
  ]);
export const verifierPolicy = () => policy([...secret(TARGET.licenseSecretArn), logs('verifier')]);
export const runtimeTrust = () =>
  policy([{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]);
export function controlPlaneDelta(): Policy {
  const s: Statement[] = [];
  for (const kind of ['writer', 'verifier'] as const) {
    const suffix = kind === 'writer' ? 'Writer' : 'Verifier';
    s.push(
      {
        Sid: `CreateBoundIMG21${suffix}Role`,
        Effect: 'Allow',
        Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        Resource: roleArn(kind),
        Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn(kind) } },
      },
      {
        Sid: `DenyUnboundedIMG21${suffix}Role`,
        Effect: 'Deny',
        Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        Resource: roleArn(kind),
        Condition: { StringNotEquals: { 'iam:PermissionsBoundary': boundaryArn(kind) } },
      },
    );
  }
  s.push(
    {
      Sid: 'ManageOnlyTwoIMG21RuntimeRoles',
      Effect: 'Allow',
      Action: [
        'iam:GetRole',
        'iam:TagRole',
        'iam:UntagRole',
        'iam:PutRolePolicy',
        'iam:GetRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:ListRolePolicies',
        'iam:UpdateAssumeRolePolicy',
      ],
      Resource: [roleArn('writer'), roleArn('verifier')],
    },
    {
      Sid: 'ManageOnlyTwoIMG21Boundaries',
      Effect: 'Allow',
      Action: [
        'iam:CreatePolicy',
        'iam:GetPolicy',
        'iam:GetPolicyVersion',
        'iam:CreatePolicyVersion',
        'iam:DeletePolicyVersion',
        'iam:SetDefaultPolicyVersion',
        'iam:ListPolicyVersions',
        'iam:TagPolicy',
        'iam:UntagPolicy',
      ],
      Resource: [boundaryArn('writer'), boundaryArn('verifier')],
    },
    {
      Sid: 'PassOnlyIMG21RolesToLambda',
      Effect: 'Allow',
      Action: ['iam:PassRole'],
      Resource: [roleArn('writer'), roleArn('verifier')],
      Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
    },
  );
  return policy(s);
}
export function reviewedControlPlanePatch(original: Policy) {
  const delta = controlPlaneDelta();
  requireThat(!original.Statement.some((s) => delta.Statement.some((d) => d.Sid === s.Sid)), 'DELTA_ALREADY_PRESENT');
  return policy([...original.Statement, ...delta.Statement]);
}
