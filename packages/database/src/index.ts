/**
 * @fdp/database：Prisma Schema/Migration（DB-01）+ 事务/Repository/并发基础库（DB-02）。
 */
import { PACKAGE_NAME as DOMAIN_PACKAGE } from '@fdp/domain';

export const PACKAGE_NAME = '@fdp/database';

/** 骨架期用于验证工作区依赖方向：database -> domain。 */
export const LAYER_CHAIN = `${DOMAIN_PACKAGE} -> ${PACKAGE_NAME}`;

export * from './errors.js';
export * from './context.js';
export * from './pagination.js';
export * from './repository.js';
export * from './transaction.js';
export * from './audit.js';
export * from './client.js';
export * from './advisory-lock.js';
