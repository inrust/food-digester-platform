/**
 * AUTH-04 模板测试 + 本地策略求值器模拟允许/拒绝矩阵。
 *
 * 验收基准「跨设备、通配发布、错误方向操作被 AWS IoT 拒绝」在本任务以
 * 本地最小 IAM 求值器做静态语义证明（策略资源为字面量 ARN，无通配符，
 * 求值只需精确匹配）；真实 AWS IoT 的端到端拒绝矩阵需部署环境凭据，
 * 归 QA-04/冒烟验证（本任务不执行需要云凭据的动作）。
 */
import { assert, describe, test } from 'vitest';
import { buildDevicePolicy, DOWNLINK_TOPIC_TYPES, UPLINK_TOPIC_TYPES } from '../src/iot-device-policy.js';
import type { IotPolicyDocument } from '../src/iot-device-policy.js';

const REGION = 'ap-southeast-1';
const ACCOUNT = '123456789012';
const THING = 'dev-0001';
const OTHER = 'dev-0002';

const { policyName, policyDocument } = buildDevicePolicy({
  region: REGION,
  accountId: ACCOUNT,
  thingName: THING,
});

const arn = (resourceType: string, name: string): string => `arn:aws:iot:${REGION}:${ACCOUNT}:${resourceType}/${name}`;

/** 本地最小求值器：字面量精确匹配（策略无通配符时与 AWS 语义等价）。 */
function allows(
  policy: IotPolicyDocument,
  action: string,
  resourceType: 'client' | 'topic' | 'topicfilter',
  name: string,
): boolean {
  const resource = arn(resourceType, name);
  return policy.Statement.some((s) => s.Action.includes(action) && s.Resource.includes(resource));
}

describe('Policy 模板结构', () => {
  test('策略名带设备前缀，Version 2012-10-17，恰好 4 条 Allow 声明', () => {
    assert.equal(policyName, `fdp-device-${THING}`);
    assert.equal(policyDocument.Version, '2012-10-17');
    assert.equal(policyDocument.Statement.length, 4);
    for (const s of policyDocument.Statement) {
      assert.equal(s.Effect, 'Allow');
    }
  });

  test('任何资源不含通配符（* + #），Action 不含通配符', () => {
    for (const s of policyDocument.Statement) {
      for (const resource of s.Resource) {
        assert.notMatch(resource, /[*+#]/, `资源不得含通配符: ${resource}`);
      }
      for (const action of s.Action) {
        assert.notInclude(action, '*');
      }
    }
  });

  test('Connect 仅允许 Client ID = Thing Name', () => {
    const connect = policyDocument.Statement.find((s) => s.Sid === 'ConnectAsSelf');
    assert.deepEqual(connect?.Action, ['iot:Connect']);
    assert.deepEqual(connect?.Resource, [arn('client', THING)]);
  });

  test('Publish 仅 8 个上行 Topic；Subscribe/Receive 仅 3 个下行 Topic', () => {
    const publish = policyDocument.Statement.find((s) => s.Sid === 'PublishOwnUplink');
    assert.equal(publish?.Resource.length, 8);
    assert.deepEqual(
      publish?.Resource,
      UPLINK_TOPIC_TYPES.map((t) => arn('topic', `bnx/device/${THING}/${t}`)),
    );
    const subscribe = policyDocument.Statement.find((s) => s.Sid === 'SubscribeOwnDownlink');
    assert.deepEqual(
      subscribe?.Resource,
      DOWNLINK_TOPIC_TYPES.map((t) => arn('topicfilter', `bnx/device/${THING}/${t}`)),
    );
    const receive = policyDocument.Statement.find((s) => s.Sid === 'ReceiveOwnDownlink');
    assert.deepEqual(
      receive?.Resource,
      DOWNLINK_TOPIC_TYPES.map((t) => arn('topic', `bnx/device/${THING}/${t}`)),
    );
  });

  test('非法输入拒绝：含通配符的 Thing Name、非法 Region/Account', () => {
    for (const bad of ['dev/+', 'dev#', 'dev-*', '', 'dev 1']) {
      assert.throws(() => buildDevicePolicy({ region: REGION, accountId: ACCOUNT, thingName: bad }), /非法 Thing Name/);
    }
    assert.throws(() => buildDevicePolicy({ region: 'XX', accountId: ACCOUNT, thingName: THING }), /非法 Region/);
    assert.throws(() => buildDevicePolicy({ region: REGION, accountId: 'abc', thingName: THING }), /非法 Account ID/);
  });
});

describe('允许矩阵（自身操作全部通过）', () => {
  test('Connect 自身', () => {
    assert.isTrue(allows(policyDocument, 'iot:Connect', 'client', THING));
  });

  test('Publish 全部 8 个上行 Topic', () => {
    for (const type of UPLINK_TOPIC_TYPES) {
      assert.isTrue(
        allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${THING}/${type}`),
        `上行 ${type} 应允许`,
      );
    }
  });

  test('Subscribe/Receive 全部 3 个下行 Topic', () => {
    for (const type of DOWNLINK_TOPIC_TYPES) {
      assert.isTrue(allows(policyDocument, 'iot:Subscribe', 'topicfilter', `bnx/device/${THING}/${type}`));
      assert.isTrue(allows(policyDocument, 'iot:Receive', 'topic', `bnx/device/${THING}/${type}`));
    }
  });
});

describe('拒绝矩阵（跨设备/通配/错误方向/未知类型全部拒绝）', () => {
  test('跨设备：以他机 Client ID 连接、发布他机上行、订阅他机下行', () => {
    assert.isFalse(allows(policyDocument, 'iot:Connect', 'client', OTHER));
    assert.isFalse(allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${OTHER}/telemetry`));
    assert.isFalse(allows(policyDocument, 'iot:Subscribe', 'topicfilter', `bnx/device/${OTHER}/cmd`));
    assert.isFalse(allows(policyDocument, 'iot:Receive', 'topic', `bnx/device/${OTHER}/ota`));
  });

  test('通配订阅/发布：多级与单级通配均无授权', () => {
    assert.isFalse(allows(policyDocument, 'iot:Subscribe', 'topicfilter', 'bnx/device/+/cmd'));
    assert.isFalse(allows(policyDocument, 'iot:Subscribe', 'topicfilter', 'bnx/device/#'));
    assert.isFalse(allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${THING}/#`));
  });

  test('错误方向：发布下行 Topic、订阅上行 Topic、接收上行 Topic', () => {
    assert.isFalse(allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${THING}/cmd`));
    assert.isFalse(allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${THING}/ota`));
    assert.isFalse(allows(policyDocument, 'iot:Subscribe', 'topicfilter', `bnx/device/${THING}/telemetry`));
    assert.isFalse(allows(policyDocument, 'iot:Receive', 'topic', `bnx/device/${THING}/heartbeat`));
  });

  test('未知 Topic 类型与相邻路径无授权', () => {
    assert.isFalse(allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${THING}/unknown`));
    assert.isFalse(allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${THING}/telemetry/extra`));
    assert.isFalse(allows(policyDocument, 'iot:Publish', 'topic', `bnx/device/${THING}x/telemetry`));
  });
});
