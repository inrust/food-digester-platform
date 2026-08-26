/**
 * @fdp/infra 构建骨架（ENG-01）。
 * AWS CDK 定义（IoT/SQS/Lambda/RDS/S3/Cognito/API Gateway）在 IAC 任务实现；
 * 本包只描述应用依赖的 AWS 资源，不包含运维告警与值守配置。
 */
export const PACKAGE_NAME = '@fdp/infra';

/** 骨架期尚无 Stack；IAC 任务按业务域追加。 */
export const STACK_NAMES: readonly string[] = [];
