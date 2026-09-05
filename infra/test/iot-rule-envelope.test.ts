/**
 * BE-IOT-01 IoT Rule → Ingress SQS Envelope 的模板断言测试。
 *
 * 验收基准的机器证明：
 * 1. 8 类上行消息进入同一 Ingress 队列且保留原文（SELECT * + useBase64=false）；
 * 2. 每条 Rule SQL 注入契约的五个 iot* 上下文字段（与 contracts/iot/ingress-envelope.schema.json 奇偶）；
 * 3. 未知 Topic 不进入业务链路（仅 8 个精确过滤器，无 # 通配订阅）；
 * 4. Error Action 写独立错误队列。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assert, describe, test } from 'vitest';
import { AppDependenciesStack } from '../src/stacks/app-dependencies-stack.js';
import { UPLINK_TOPIC_TYPES, uplinkTopicFilter } from '../src/topics.js';

const envelopeSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../contracts/iot/ingress-envelope.schema.json', import.meta.url)), 'utf8'),
) as { required: string[]; properties: Record<string, { enum?: string[] }> };

function synthTemplate(): Template {
  const app = new App();
  return Template.fromStack(
    new AppDependenciesStack(app, 'TestStack', {
      config: { envName: 'test', allowInsecureDeviceEndpointForLocal: true },
    }),
  );
}

const EXPECTED_CONTEXT_FIELDS = ['iotTopic', 'iotDeviceId', 'iotType', 'iotReceivedAt', 'iotPrincipal'] as const;

describe('BE-IOT-01 IoT Rule Envelope', () => {
  const template = synthTemplate();
  const rules = Object.values(template.findResources('AWS::IoT::TopicRule')).map(
    (r) =>
      r.Properties.TopicRulePayload as {
        Sql: string;
        Actions: { Sqs: { QueueUrl: unknown; UseBase64?: boolean } }[];
        ErrorAction: { Sqs: { QueueUrl: unknown } };
      },
  );

  test('8 条 Rule 对应 8 个上行精确过滤器，无 # 通配订阅（未知 Topic 不进业务链路）', () => {
    assert.equal(rules.length, 8);
    const filters = rules.map((r) => /FROM '([^']+)'/.exec(r.Sql)?.[1]).sort();
    assert.deepEqual(filters, UPLINK_TOPIC_TYPES.map(uplinkTopicFilter).sort());
    for (const sql of rules.map((r) => r.Sql)) {
      assert.notInclude(sql, '#', '禁止全量通配订阅');
    }
  });

  test('每条 Rule SQL 注入契约五个 iot* 上下文字段且保留原始 Payload（SELECT *）', () => {
    // 与 Envelope Schema required 奇偶：契约必填字段必须全部由 SQL 注入
    assert.deepEqual([...envelopeSchema.required].sort(), [...EXPECTED_CONTEXT_FIELDS].sort());
    for (const { Sql } of rules) {
      assert.match(Sql, /^SELECT \*, /, '必须保留原始 Payload 全字段平铺');
      assert.include(Sql, 'topic() AS iotTopic');
      assert.include(Sql, 'topic(3) AS iotDeviceId');
      assert.include(Sql, 'topic(4) AS iotType');
      assert.include(Sql, 'timestamp() AS iotReceivedAt');
      assert.include(Sql, 'principal() AS iotPrincipal');
    }
    // Schema 枚举与 IaC 上行清单奇偶
    assert.deepEqual([...(envelopeSchema.properties.iotType?.enum ?? [])].sort(), [...UPLINK_TOPIC_TYPES].sort());
  });

  test('Action 不 Base64 包装（保留 JSON 原文），Error Action 写独立错误队列', () => {
    const ingressUrls = new Set<string>();
    const errorUrls = new Set<string>();
    for (const rule of rules) {
      assert.equal(rule.Actions.length, 1);
      assert.notEqual(rule.Actions[0]?.Sqs.UseBase64, true, 'useBase64 必须为 false 以保留原文');
      ingressUrls.add(JSON.stringify(rule.Actions[0]?.Sqs.QueueUrl));
      errorUrls.add(JSON.stringify(rule.ErrorAction.Sqs.QueueUrl));
    }
    assert.equal(ingressUrls.size, 1, '8 类消息进入同一 Ingress 队列');
    assert.equal(errorUrls.size, 1);
    assert.notDeepEqual([...ingressUrls], [...errorUrls], '错误队列独立于业务队列');
  });
});
