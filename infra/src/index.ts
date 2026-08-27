/**
 * @fdp/infra 应用依赖 CDK 定义（IAC-01）。
 * 只描述应用依赖的 AWS 资源，不包含运维告警与值守配置。
 */
export const PACKAGE_NAME = '@fdp/infra';

/** 本包交付的 Stack 逻辑 ID（物理名为 fdp-{env}-app）。 */
export const STACK_IDS = ['AppDependencies'] as const;

export { AppDependenciesStack } from './stacks/app-dependencies-stack.js';
export type { AppDependenciesStackProps } from './stacks/app-dependencies-stack.js';
export { ENV_NAME_PATTERN, resolveConfig, validateEnvName } from './config.js';
export type { DeviceApiDomainConfig, InfraConfig } from './config.js';
export { Naming, PROJECT_PREFIX } from './naming.js';
export { DOWNLINK_TOPIC_TYPES, TOPIC_PATTERN, UPLINK_TOPIC_TYPES, uplinkTopicFilter } from './topics.js';
export type { DownlinkTopicType, UplinkTopicType } from './topics.js';
