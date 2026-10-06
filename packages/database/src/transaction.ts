/**
 * DB-02 事务封装。
 * - 交互式事务：fn 内任何异常都会回滚全部写入，不产生部分数据；
 * - 嵌套调用复用外层事务，不开启新事务；
 * - AsyncLocalStorage 上下文在事务内自动传播（见 context.ts）。
 */
import { beginDataPathPhase, observeDataPathPhase } from '@fdp/observability';
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
  observe = false,
): Promise<T> {
  if (isTransactionClient(client)) return fn(client);
  if (!observe) return (client as PrismaClient).$transaction(fn, options);
  return observeDataPathPhase('db-transaction', async () => {
    const opened = beginDataPathPhase('db-transaction-open');
    let finish: ReturnType<typeof beginDataPathPhase> | undefined;
    try {
      const result = await (client as PrismaClient).$transaction(async (tx) => {
        opened();
        try {
          return await observeDataPathPhase('db-transaction-callback', () => fn(tx));
        } finally {
          finish = beginDataPathPhase('db-transaction-finish');
        }
      }, options);
      finish?.();
      return result;
    } catch (error) {
      opened(error ?? new Error('TRANSACTION_OPEN_FAILED'));
      finish?.(error ?? new Error('TRANSACTION_FINISH_FAILED'));
      throw error;
    }
  });
}
