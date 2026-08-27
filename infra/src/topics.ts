/**
 * IAC-01 Topic 清单。
 *
 * 事实源：contracts/mqtt/topic-catalog.json（CT-02）。
 * 本文件只保存 IaC 路由所需的最小子集，一致性由 test/topic-catalog-parity.test.ts 强制；
 * 禁止在此单独增删 Topic，变更必须先改契约目录。
 */

/** 8 个上行 Topic（设备 → 云端），IoT Rule 按类型逐一路由到 Ingress SQS。 */
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

export type UplinkTopicType = (typeof UPLINK_TOPIC_TYPES)[number];

/** 3 个下行 Topic（云端 → 设备），用于收敛 API Lambda 的 iot:Publish 权限。 */
export const DOWNLINK_TOPIC_TYPES = ['cmd', 'ota', 'notification'] as const;

export type DownlinkTopicType = (typeof DOWNLINK_TOPIC_TYPES)[number];

export const TOPIC_PATTERN = 'bnx/device/{deviceId}/{type}' as const;

/** IoT Rule SQL 的 Topic 过滤器：bnx/device/+/{type}。 */
export function uplinkTopicFilter(type: UplinkTopicType): string {
  return `bnx/device/+/${type}`;
}
