import { PACKAGE_NAME as DOMAIN_PACKAGE } from '@fdp/domain';

/**
 * @fdp/database 构建骨架（ENG-01）。
 * Prisma Schema、Migration、事务与 Customer scope Repository 在 DB-01/DB-02 实现。
 */
export const PACKAGE_NAME = '@fdp/database';

/** 骨架期用于验证工作区依赖方向：database -> domain。 */
export const LAYER_CHAIN = `${DOMAIN_PACKAGE} -> ${PACKAGE_NAME}`;
