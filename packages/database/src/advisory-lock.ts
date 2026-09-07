/**
 * 获取 PostgreSQL 事务级 advisory lock。
 * 调用方必须传入现有事务 client；锁随事务提交/回滚自动释放。
 */
import type { DbClient } from './transaction.js';
import { Prisma } from './generated/client.js';

export async function acquireTransactionLock(client: DbClient, scope: string): Promise<void> {
  // IS NULL 将 pg_advisory_xact_lock 的 void 结果转换为 Prisma 可反序列化的 boolean。
  await client.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0)) IS NULL AS acquired`);
}
