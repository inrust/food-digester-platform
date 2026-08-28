/**
 * database 包测试辅助：按序拼接全部 migration（与 apps/cloud-api/test/helpers.ts 同策略）。
 * 生成的 Prisma Client 以最新 Schema 为准，测试库必须应用全部迁移才能写入带新增列的表。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = new URL('../prisma/migrations/', import.meta.url);

/** 按目录名（时间戳前缀）排序拼接全部 migration.sql。 */
export function readAllMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => /^\d{14}_[a-z0-9_]+$/.test(entry))
    .sort()
    .map((entry) => readFileSync(fileURLToPath(new URL(`${entry}/migration.sql`, MIGRATIONS_DIR)), 'utf8'))
    .join('\n');
}
