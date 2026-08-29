/**
 * @fdp/domain 构建骨架（ENG-01）+ DOM-01 设备状态机。
 * 领域规则在本包实现；状态迁移只能通过本包的领域服务，不允许直接修改状态字段。
 */
export const PACKAGE_NAME = '@fdp/domain';

export * from './device-lifecycle.js';
export * from './license.js';
export * from './configuration.js';
export * from './contract.js';
