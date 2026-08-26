/**
 * CT-02 MQTT Topic 与 QoS 契约。
 *
 * 事实源：contracts/mqtt/topic-catalog.json（本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：ADP-002@1.0.0（QoS 2→1 适配）、PRI-001@1.0.0（三级优先原则）。
 *
 * 功能边界：不创建 AWS 资源，不处理 Payload。
 */

export const TOPIC_PREFIX = 'bnx/device' as const;

export type TopicDirection = 'uplink' | 'downlink';

export type UplinkTopicType =
  | 'heartbeat'
  | 'telemetry'
  | 'report'
  | 'alarm'
  | 'event'
  | 'ack'
  | 'tamper'
  | 'media';

export type DownlinkTopicType = 'cmd' | 'ota' | 'notification';

export type TopicType = UplinkTopicType | DownlinkTopicType;

/** 协议规定 QoS（specifiedQos），来自《Device-Cloud Communication Design》。 */
export type SpecifiedQos = 1 | 2;
/** AWS IoT Core 实施 QoS（awsEffectiveQos），AWS 仅支持 0/1，本项目固定适配为 1。 */
export type AwsEffectiveQos = 1;

export interface TopicSpec {
  readonly type: TopicType;
  readonly name: string;
  readonly direction: TopicDirection;
  readonly frequency: string;
  readonly specifiedQos: SpecifiedQos;
  readonly awsEffectiveQos: AwsEffectiveQos;
  readonly payloadEnvelope: string;
}

export const TOPIC_CATALOG: Readonly<Record<TopicType, TopicSpec>> = {
  heartbeat: { type: 'heartbeat', name: 'Heartbeat', direction: 'uplink', frequency: '每 60 秒', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
  telemetry: { type: 'telemetry', name: 'Telemetry', direction: 'uplink', frequency: '每 10～60 秒可配置', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+audit+data' },
  report: { type: 'report', name: 'ESG Report', direction: 'uplink', frequency: '每周期/每小时/每日', specifiedQos: 2, awsEffectiveQos: 1, payloadEnvelope: 'meta+audit+data' },
  alarm: { type: 'alarm', name: 'Alarm', direction: 'uplink', frequency: '事件触发', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
  event: { type: 'event', name: 'Event', direction: 'uplink', frequency: '事件触发', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
  ack: { type: 'ack', name: 'ACK', direction: 'uplink', frequency: '命令执行后', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
  tamper: { type: 'tamper', name: 'Tamper', direction: 'uplink', frequency: '事件触发', specifiedQos: 2, awsEffectiveQos: 1, payloadEnvelope: 'meta+audit+data' },
  media: { type: 'media', name: 'Media', direction: 'uplink', frequency: '事件触发', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
  cmd: { type: 'cmd', name: 'Command', direction: 'downlink', frequency: '按需', specifiedQos: 2, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
  ota: { type: 'ota', name: 'OTA', direction: 'downlink', frequency: '按需', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
  notification: { type: 'notification', name: 'Notification', direction: 'downlink', frequency: '按需', specifiedQos: 1, awsEffectiveQos: 1, payloadEnvelope: 'meta+data' },
} as const;

export const UPLINK_TOPIC_TYPES: readonly UplinkTopicType[] = Object.values(TOPIC_CATALOG)
  .filter((s) => s.direction === 'uplink')
  .map((s) => s.type as UplinkTopicType);

export const DOWNLINK_TOPIC_TYPES: readonly DownlinkTopicType[] = Object.values(TOPIC_CATALOG)
  .filter((s) => s.direction === 'downlink')
  .map((s) => s.type as DownlinkTopicType);

/** deviceId 合法字符：非空、可打印、不含 MQTT 分隔符与通配符。与 IoT Thing Name 保持一致（AUTH-04）。 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9:_@.-]{1,128}$/;

export class TopicError extends Error {
  readonly reason:
    | 'INVALID_PREFIX'
    | 'INVALID_SEGMENT_COUNT'
    | 'EMPTY_DEVICE_ID'
    | 'INVALID_DEVICE_ID'
    | 'UNKNOWN_TOPIC_TYPE';

  constructor(reason: TopicError['reason'], topic: string) {
    super(`${reason}: ${topic}`);
    this.name = 'TopicError';
    this.reason = reason;
  }
}

export function isValidDeviceId(deviceId: string): boolean {
  return DEVICE_ID_PATTERN.test(deviceId);
}

export function isTopicType(value: string): value is TopicType {
  return Object.hasOwn(TOPIC_CATALOG, value);
}

/** 构造严格符合 bnx/device/{deviceId}/{type} 的 Topic。 */
export function buildTopic(deviceId: string, type: TopicType): string {
  if (deviceId.length === 0) throw new TopicError('EMPTY_DEVICE_ID', deviceId);
  if (!isValidDeviceId(deviceId)) throw new TopicError('INVALID_DEVICE_ID', deviceId);
  return `${TOPIC_PREFIX}/${deviceId}/${type}`;
}

export interface ParsedTopic {
  readonly deviceId: string;
  readonly type: TopicType;
  readonly direction: TopicDirection;
  readonly spec: TopicSpec;
}

/** 解析并校验 Topic；未知层级、空/非法 deviceId、未知 type 均抛出 TopicError。 */
export function parseTopic(topic: string): ParsedTopic {
  const segments = topic.split('/');
  if (segments.length !== 4) throw new TopicError('INVALID_SEGMENT_COUNT', topic);
  if (segments[0] !== 'bnx' || segments[1] !== 'device') {
    throw new TopicError('INVALID_PREFIX', topic);
  }
  const deviceId = segments[2]!;
  if (deviceId.length === 0) throw new TopicError('EMPTY_DEVICE_ID', topic);
  if (!isValidDeviceId(deviceId)) throw new TopicError('INVALID_DEVICE_ID', topic);
  const type = segments[3]!;
  if (!isTopicType(type)) throw new TopicError('UNKNOWN_TOPIC_TYPE', topic);
  const spec = TOPIC_CATALOG[type];
  return { deviceId, type, direction: spec.direction, spec };
}

/** 实际发布/订阅应使用的 AWS 生效 QoS。 */
export function effectiveQos(type: TopicType): AwsEffectiveQos {
  return TOPIC_CATALOG[type].awsEffectiveQos;
}

export interface TopicPermissionTemplate {
  readonly deviceId: string;
  /** 设备允许发布的自身上行 Topic（精确匹配，无通配）。 */
  readonly publish: readonly string[];
  /** 设备允许订阅的自身下行 Topic filter。 */
  readonly subscribe: readonly string[];
  /** 设备允许接收的自身下行 Topic。 */
  readonly receive: readonly string[];
}

/**
 * 单设备最小权限发布/订阅模板：只能发布自身上行 Topic、只能订阅自身下行 Topic。
 * AUTH-04 将据此生成 AWS IoT Policy（Client ID 与 Thing Name 一致）。
 */
export function deviceTopicPermissionTemplate(deviceId: string): TopicPermissionTemplate {
  return {
    deviceId,
    publish: UPLINK_TOPIC_TYPES.map((t) => buildTopic(deviceId, t)),
    subscribe: DOWNLINK_TOPIC_TYPES.map((t) => buildTopic(deviceId, t)),
    receive: DOWNLINK_TOPIC_TYPES.map((t) => buildTopic(deviceId, t)),
  };
}
