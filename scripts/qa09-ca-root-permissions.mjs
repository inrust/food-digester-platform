import { isDeepStrictEqual } from 'node:util';
export function assertCaRepairPermissions(baseline, proposed, policy) {
  const expiry = { DateLessThan: { 'aws:CurrentTime': '2026-10-03T00:00:00Z' } };
  const secret = 'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-device-ca-mecYC7';
  const role = 'arn:aws:iam::065986019555:role/fdp-test-onboarding-provisioning-role';
  const key = 'arn:aws:kms:ap-southeast-1:065986019555:key/22af85c4-76d3-40c9-a849-0621740afe6c';
  const expectedBoundary = structuredClone(baseline);
  expectedBoundary.Statement.push({
    Sid: 'TemporaryQA09ExactWorkerCaRootWrite',
    Effect: 'Allow',
    Action: ['secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecretVersionStage'],
    Resource: secret,
    Condition: { ...expiry, ArnEquals: { 'aws:PrincipalArn': role } },
  });
  const expectedPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ExactCaSecretVersionRepair',
        Effect: 'Allow',
        Action: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:UpdateSecretVersionStage',
        ],
        Resource: secret,
        Condition: expiry,
      },
      {
        Sid: 'ExactCaKeyThroughSecretsManager',
        Effect: 'Allow',
        Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
        Resource: key,
        Condition: {
          ...expiry,
          StringEquals: {
            'kms:ViaService': 'secretsmanager.ap-southeast-1.amazonaws.com',
            'kms:EncryptionContext:SecretARN': secret,
          },
        },
      },
    ],
  };
  if (!isDeepStrictEqual(proposed, expectedBoundary) || !isDeepStrictEqual(policy, expectedPolicy))
    throw Error('APPROVED_PERMISSION_SCOPE_MISMATCH');
}
