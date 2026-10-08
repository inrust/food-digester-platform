/**
 * DB-02 PrismaClient 工厂。
 * 生产/开发环境使用 @prisma/adapter-pg（DATABASE_URL）；测试使用 PGlite 适配器（见 test/）。
 * Prisma 7：连接 URL 由 adapter 提供，schema 内不再配置 url。
 */
import { ObservedPrismaPg } from './observed-pg.js';
import { observeDatabaseClientPreparation } from './client-preparation.js';
import { PrismaClient } from './generated/client.js';
import { AuthenticatedPreconnect } from './authenticated-preconnect.js';
import { observeDatabaseEnginePreparation } from './client-preparation.js';
import { markContractLoadModelEntry } from './contract-load-observation.js';

/** Defaults remain compatible; deployment sets an explicit per-function pool budget. */
export const DATABASE_POOL_CONFIG = Object.freeze({
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
});

export function resolveDatabasePoolMax(value = process.env.FDP_DB_POOL_MAX): 1 | 2 {
  if (value === undefined) return 2;
  if (value === '1') return 1;
  if (value === '2') return 2;
  throw new Error('INVALID_DATABASE_POOL_MAX');
}

function createObservedClient(databaseUrl: string, preconnect?: AuthenticatedPreconnect): PrismaClient {
  if (preconnect && resolveDatabasePoolMax() !== 1) throw new Error('PRECONNECT_REQUIRES_POOL1');
  const client = new PrismaClient({
    adapter: new ObservedPrismaPg(
      {
        connectionString: databaseUrl,
        ...DATABASE_POOL_CONFIG,
        max: resolveDatabasePoolMax(),
      },
      preconnect,
    ),
  });
  // Public query extension keeps Prisma's lazy execution/transaction machinery; no eager $connect or SQL.
  return client.$extends({
    name: 'fdp-client-preparation-observation',
    query: {
      $allOperations({ args, query, model, operation }) {
        markContractLoadModelEntry(model, operation);
        return observeDatabaseClientPreparation(() => query(args));
      },
    },
  }) as unknown as PrismaClient;
}
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return createObservedClient(databaseUrl);
}
/** Explicit Admin candidate; caller guards test/pool1/engine. Ordinary factory stays lazy/default off. */
export function createAdminPreconnectCandidate(databaseUrl: string): {
  client: PrismaClient;
  prepareAuthenticated: () => Promise<void>;
} {
  const ownership = new AuthenticatedPreconnect();
  const client = createObservedClient(databaseUrl, ownership);
  return {
    client,
    prepareAuthenticated: () => ownership.prepare(() => observeDatabaseEnginePreparation(() => client.$connect())),
  };
}

// PrismaClient 同时导出值（测试/Worker 用适配器构造）与类型
export { PrismaClient } from './generated/client.js';
export type { Prisma } from './generated/client.js';
