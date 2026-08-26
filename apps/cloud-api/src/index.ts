import { PACKAGE_NAME as DOMAIN_PACKAGE } from '@fdp/domain';
import { PACKAGE_NAME as DATABASE_PACKAGE } from '@fdp/database';
import { PACKAGE_NAME as OBSERVABILITY_PACKAGE } from '@fdp/observability';

/**
 * cloud-api 构建骨架（ENG-01）。
 * /api/v1/device、/admin、/customer、/internal 路由在 BE/CT-05 后续任务实现。
 */
export const SERVICE_NAME = 'cloud-api';

/** 骨架期用于验证 apps -> packages 的单向依赖与构建顺序。 */
export function serviceLayers(): readonly string[] {
  return [DOMAIN_PACKAGE, DATABASE_PACKAGE, OBSERVABILITY_PACKAGE];
}
