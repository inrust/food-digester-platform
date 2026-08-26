/**
 * DB-02 PrismaClient 工厂。
 * 生产/开发环境使用 @prisma/adapter-pg（DATABASE_URL）；测试使用 PGlite 适配器（见 test/）。
 * Prisma 7：连接 URL 由 adapter 提供，schema 内不再配置 url。
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export type { Prisma, PrismaClient } from './generated/client.js';
