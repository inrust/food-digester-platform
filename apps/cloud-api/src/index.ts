import { PACKAGE_NAME as DOMAIN_PACKAGE } from '@fdp/domain';
import { PACKAGE_NAME as DATABASE_PACKAGE } from '@fdp/database';
import { PACKAGE_NAME as OBSERVABILITY_PACKAGE } from '@fdp/observability';

/**
 * cloud-api 构建骨架（ENG-01）。
 * BE-ONB-01 已落地：POST /api/v1/device/onboarding/request（见 ./onboarding）；
 * BE-ONB-02 已落地：/api/v1/admin/onboarding/requests 列表/详情/approve/reject（见 ./admin/onboarding）；
 * BE-CUS-01 已落地：/api/v1/admin/customers 列表/创建/详情/更新/停用/软删除（见 ./admin/customer）；
 * BE-CUS-02 已落地：/api/v1/admin/sites 列表/创建/详情/更新/停用/软删除（见 ./admin/site）；
 * BE-DEV-01 已落地：/api/v1/admin/devices 台账列表/详情（只读，见 ./admin/device）；
 * BE-DEV-02 已落地：/api/v1/admin/devices/{deviceId}/assignment 分配/调整 + 分配历史（见 ./admin/device-assignment）；
 * BE-DEV-03 已落地：/api/v1/admin/devices/{deviceId}/suspend|reactivate 挂起/恢复（见 ./admin/device-status）；
 * BE-DEV-04 已落地：/api/v1/admin/devices/{deviceId}/retire[/complete] 退役工作流（见 ./admin/device-retirement）；
 * BE-SYNC-02 已落地：/api/v1/device/deactivate 退役确认（见 ./device/deactivate）；
 * BE-SYNC-01 已落地：/api/v1/device/sync 统一设备同步快照（见 ./device/sync）；
 * BE-LIC-01 已落地：/api/v1/admin/licenses 创建/签发/激活/续期/吊销/详情/历史（见 ./admin/license）；
 * BE-CFG-01 已落地：/api/v1/admin/configurations 配置版本管理（见 ./admin/configuration）；
 * BE-CON-01 已落地：/api/v1/admin/contracts Contract CRUD/状态（见 ./admin/contract）；
 * BE-CON-02 已落地：/api/v1/admin/contracts/{id}/devices 关联/解绑/历史（见 ./admin/contract-device）；
 * BE-CNS-01 已落地：/api/v1/admin/consumables 耗材状态查询 + 投影保存（见 ./consumable）；
 * BE-CNS-02 已落地：/api/v1/admin/consumable-requests 更换申请工作流（见 ./consumable）；
 * BE-DUSR-01 已落地：/api/v1/admin/device-users 设备操作员管理（见 ./admin/device-user）；
 * BE-DUSR-02 已落地：设备本地密码验证值生成器（KDF adapter/DTO/脱敏管线，DEC-004 冻结前 fail-closed，见 ./admin/device-user/verifier）；
 * BE-ALM-01 已落地：/api/v1/admin/alarms 查询/确认/清除 + /events、/tamper-events 只读查询（见 ./admin/alarm）；
 * BE-ALM-02 已落地：业务通知适配器（消费 Critical Alarm/Tamper 领域事件 → 邮件/Webhook，见 ./notification/business-notifier）；
 * BE-ESG-02 已落地：/api/v1/admin/esg 查询与 CSV 导出（含 Export Worker，见 ./admin/esg）；
 * BE-CMD-01 已落地：POST /api/v1/admin/devices/{id}/commands 创建与授权（见 ./admin/command）；
 * BE-OTA-01 已落地：/api/v1/admin/ota/packages 上传会话/complete 校验/列表/详情（见 ./admin/ota-package）；
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
export * from './admin/replay/index.js';
export * from './admin/customer/index.js';
export * from './admin/site/index.js';
export * from './admin/device/index.js';
export * from './admin/device-assignment/index.js';
export * from './admin/device-status/index.js';
export * from './admin/device-retirement/index.js';
export * from './admin/license/index.js';
export * from './admin/configuration/index.js';
export * from './admin/contract/index.js';
export * from './admin/contract-device/index.js';
export * from './admin/device-user/index.js';
export * from './admin/alarm/index.js';
export * from './admin/command/index.js';
export * from './admin/ota-package/index.js';
export * from './admin/esg/index.js';
export * from './consumable/index.js';
export * from './notification/index.js';
export * from './provisioning/index.js';
export * from './device/index.js';
