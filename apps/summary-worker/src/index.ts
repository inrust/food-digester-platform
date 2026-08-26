import { PACKAGE_NAME as DATABASE_PACKAGE } from '@fdp/database';

/**
 * summary-worker 构建骨架（ENG-01）。
 * 遥测聚合、ESG 计算与投影更新在 BE-ESG 等后续任务实现。
 */
export const SERVICE_NAME = 'summary-worker';

export function serviceLayers(): readonly string[] {
  return [DATABASE_PACKAGE];
}
