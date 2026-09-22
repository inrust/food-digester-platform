/**
 * DB-02 PrismaClient 工厂。
 * 生产/开发环境使用 @prisma/adapter-pg（DATABASE_URL）；测试使用 PGlite 适配器（见 test/）。
 * Prisma 7：连接 URL 由 adapter 提供，schema 内不再配置 url。
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

/**
 * Lambda 每执行环境的数据库连接预算。
 *
 * db.t4g.micro 实测只有 76 个普通连接槽位；全部数据库型 Lambda 的 CDK
 * Reserved Concurrency 合计为 31，因此每容器最多 2 条连接可把理论峰值压在 62。
 */
export const DATABASE_POOL_CONFIG = Object.freeze({
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
});

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      ...DATABASE_POOL_CONFIG,
    }),
  });
}

// PrismaClient 同时导出值（测试/Worker 用适配器构造）与类型
export { PrismaClient } from './generated/client.js';
export type { Prisma } from './generated/client.js';
