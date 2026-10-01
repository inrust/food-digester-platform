/**
 * DB-02 事务封装。
 * - 交互式事务：fn 内任何异常都会回滚全部写入，不产生部分数据；
 * - 嵌套调用复用外层事务，不开启新事务；
 * - AsyncLocalStorage 上下文在事务内自动传播（见 context.ts）。
 */
import type { Prisma, PrismaClient } from './generated/client.js';

export type DbClient = PrismaClient | Prisma.TransactionClient;

function isTransactionClient(client: DbClient): client is Prisma.TransactionClient {
  // PrismaClient 具备连接管理方法；TransactionClient 没有（其 $transaction 存在但会尝试开启嵌套事务）
  return typeof (client as PrismaClient).$connect !== 'function';
}

export async function withTransaction<T>(
  client: DbClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  if (isTransactionClient(client)) return fn(client);
  return (client as PrismaClient).$transaction(fn, options);
}
