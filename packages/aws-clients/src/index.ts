/**
 * @fdp/aws-clients：AWS 服务客户端与策略构造。
 * AUTH-04：IoT 单设备最小权限 Policy 生成器。
 */
export const PACKAGE_NAME = '@fdp/aws-clients';

export { buildDevicePolicy, DOWNLINK_TOPIC_TYPES, TOPIC_PATTERN, UPLINK_TOPIC_TYPES } from './iot-device-policy.js';
export type { DevicePolicy, DevicePolicyInput, IotPolicyDocument, IotPolicyStatement } from './iot-device-policy.js';
