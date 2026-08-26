import { PACKAGE_NAME as DOMAIN_PACKAGE } from '@fdp/domain';
import { PACKAGE_NAME as OBSERVABILITY_PACKAGE } from '@fdp/observability';

/**
 * ingestion-worker 构建骨架（ENG-01）。
 * IoT 消息接收、JSON Schema 校验、幂等与隔离在 BE-IOT 系列任务实现。
 */
export const SERVICE_NAME = 'ingestion-worker';

export function serviceLayers(): readonly string[] {
  return [DOMAIN_PACKAGE, OBSERVABILITY_PACKAGE];
}
