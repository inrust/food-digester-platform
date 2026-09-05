import { assert, describe, test } from 'vitest';
import {
  broadAllowViolations,
  collectPolicyStatements,
  wildcardKmsPrincipalViolations,
} from '../src/template-security.js';

const policy = (type: string, properties: Record<string, unknown>) => ({
  Resources: { Bad: { Type: type, Properties: properties } },
});
const broad = { Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::bucket/*' };

describe('IAC-01 模板安全 Gate 负向样本', () => {
  test.each([
    ['AWS::IAM::Policy', { PolicyDocument: { Statement: [broad] } }],
    ['AWS::IAM::ManagedPolicy', { PolicyDocument: { Statement: [broad] } }],
    ['AWS::IAM::Role', { Policies: [{ PolicyDocument: { Statement: [broad] } }] }],
  ])('%s 中 service:* + wildcard Resource 会失败', (type, properties) => {
    assert.equal(broadAllowViolations(policy(type, properties)).length, 1);
  });

  test('KMS KeyPolicy 被纳入收集且拒绝通配数据面 Principal', () => {
    const template = policy('AWS::KMS::Key', {
      KeyPolicy: { Statement: [{ Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Principal: { AWS: '*' } }] },
    });
    assert.equal(collectPolicyStatements(template).length, 1);
    assert.equal(wildcardKmsPrincipalViolations(template).length, 1);
  });
});
