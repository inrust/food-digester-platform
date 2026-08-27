/**
 * AUTH-04 IoT 单设备最小权限 Policy 生成器。
 *
 * 事实源：contracts/mqtt/topic-catalog.json（CT-02，8 上行 + 3 下行 Topic）；
 * Topic 清单在此保持同构，一致性由 test/topic-parity.test.ts 强制。
 *
 * 安全规则（技术对接要求）：
 * - Connect 资源锁定 `client/{thingName}`：强制 Client ID 与 Thing Name 一致；
 * - Publish 仅允许自身 8 个上行 Topic；Subscribe/Receive 仅允许自身 3 个下行 Topic；
 * - 全部资源为字面量 ARN：任何通配符（* + #）都不允许出现在策略中；
 * - 设备不能发布下行 Topic，也不能订阅/接收其他设备 Topic（结构上做不到）。
 *
 * 功能边界：不负责批量制造与 JITR/JITP（BE-ONB-03 逐台调用 CreatePolicy/AttachPolicy）。
 */

/** CT-02 上行 Topic 类型（设备 → 云端）。 */
export const UPLINK_TOPIC_TYPES = [
  'heartbeat',
  'telemetry',
  'report',
  'alarm',
  'event',
  'ack',
  'tamper',
  'media',
] as const;

/** CT-02 下行 Topic 类型（云端 → 设备）。 */
export const DOWNLINK_TOPIC_TYPES = ['cmd', 'ota', 'notification'] as const;

export const TOPIC_PATTERN = 'bnx/device/{deviceId}/{type}' as const;

/** IoT Thing Name 合法字符（保守子集）；含通配符/分隔符的名称直接拒绝。 */
const THING_NAME_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z-]+-\d$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;

export interface IotPolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Allow';
  readonly Action: readonly string[];
  readonly Resource: readonly string[];
}

export interface IotPolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: readonly IotPolicyStatement[];
}

export interface DevicePolicyInput {
  readonly region: string;
  readonly accountId: string;
  /** Thing Name，与 deviceId 一致，同时是 MQTT Client ID。 */
  readonly thingName: string;
  /** Policy 名前缀，默认 `fdp-device`（完整名 `{prefix}-{thingName}`）。 */
  readonly policyNamePrefix?: string;
}

export interface DevicePolicy {
  readonly policyName: string;
  readonly policyDocument: IotPolicyDocument;
}

export function buildDevicePolicy(input: DevicePolicyInput): DevicePolicy {
  if (!THING_NAME_PATTERN.test(input.thingName)) {
    throw new Error(`非法 Thing Name: ${input.thingName}（必须匹配 ${THING_NAME_PATTERN.source}）`);
  }
  if (!REGION_PATTERN.test(input.region)) {
    throw new Error(`非法 Region: ${input.region}`);
  }
  if (!ACCOUNT_ID_PATTERN.test(input.accountId)) {
    throw new Error(`非法 Account ID: ${input.accountId}`);
  }

  const arn = (resourceType: 'client' | 'topic' | 'topicfilter', name: string): string =>
    `arn:aws:iot:${input.region}:${input.accountId}:${resourceType}/${name}`;

  const uplinkTopics = UPLINK_TOPIC_TYPES.map((type) => arn('topic', `bnx/device/${input.thingName}/${type}`));
  const downlinkTopics = DOWNLINK_TOPIC_TYPES.map((type) => arn('topic', `bnx/device/${input.thingName}/${type}`));
  const downlinkFilters = DOWNLINK_TOPIC_TYPES.map((type) =>
    arn('topicfilter', `bnx/device/${input.thingName}/${type}`),
  );

  return {
    policyName: `${input.policyNamePrefix ?? 'fdp-device'}-${input.thingName}`,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ConnectAsSelf',
          Effect: 'Allow',
          Action: ['iot:Connect'],
          Resource: [arn('client', input.thingName)],
        },
        {
          Sid: 'PublishOwnUplink',
          Effect: 'Allow',
          Action: ['iot:Publish'],
          Resource: uplinkTopics,
        },
        {
          Sid: 'SubscribeOwnDownlink',
          Effect: 'Allow',
          Action: ['iot:Subscribe'],
          Resource: downlinkFilters,
        },
        {
          Sid: 'ReceiveOwnDownlink',
          Effect: 'Allow',
          Action: ['iot:Receive'],
          Resource: downlinkTopics,
        },
      ],
    },
  };
}
