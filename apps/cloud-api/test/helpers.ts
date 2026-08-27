/**
 * cloud-api 测试辅助：PGlite 真实 PostgreSQL + 按序应用全部 migration。
 */
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@fdp/database';

const MIGRATIONS_DIR = new URL('../../../packages/database/prisma/migrations/', import.meta.url);

/** 按目录名（时间戳前缀）排序拼接全部 migration.sql。 */
export function readAllMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => /^\d{14}_[a-z0-9_]+$/.test(entry))
    .sort()
    .map((entry) => readFileSync(fileURLToPath(new URL(`${entry}/migration.sql`, MIGRATIONS_DIR)), 'utf8'))
    .join('\n');
}

export async function createTestDb(): Promise<{ pg: PGlite; prisma: InstanceType<typeof PrismaClient> }> {
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(readAllMigrationSql());
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  return { pg, prisma };
}
