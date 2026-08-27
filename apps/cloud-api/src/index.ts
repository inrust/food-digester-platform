import { PACKAGE_NAME as DOMAIN_PACKAGE } from '@fdp/domain';
import { PACKAGE_NAME as DATABASE_PACKAGE } from '@fdp/database';
import { PACKAGE_NAME as OBSERVABILITY_PACKAGE } from '@fdp/observability';

/**
 * cloud-api 构建骨架（ENG-01）。
 * BE-ONB-01 已落地：POST /api/v1/device/onboarding/request（见 ./onboarding）；
 * BE-ONB-02 已落地：/api/v1/admin/onboarding/requests 列表/详情/approve/reject（见 ./admin/onboarding）；
 * 其余 /api/v1/device、/admin、/customer、/internal 路由在后续 BE 任务实现。
 */
export const SERVICE_NAME = 'cloud-api';

/** 骨架期用于验证 apps -> packages 的单向依赖与构建顺序。 */
export function serviceLayers(): readonly string[] {
  return [DOMAIN_PACKAGE, DATABASE_PACKAGE, OBSERVABILITY_PACKAGE];
}

export * from './onboarding/index.js';
export * from './admin/onboarding/index.js';
export * from './admin/certificate-rotation/index.js';
export * from './provisioning/index.js';
export * from './device/index.js';
