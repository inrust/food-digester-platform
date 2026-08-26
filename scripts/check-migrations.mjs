#!/usr/bin/env node
/**
 * ENG-02 Migration 检查门禁。
 *
 * 规则（作用于 packages/database/prisma）：
 *  1. 若不存在 schema.prisma：数据库 Schema 未落地（DB-01 前），跳过并通过。
 *  2. 若存在 schema.prisma：migrations/ 必须存在且非空（防止改了 Schema 未提交 Migration）；
 *  3. 每个 Migration 目录名必须符合 <14位时间戳>_<snake_case 名称>，且含非空 migration.sql；
 *  4. 必须存在 migration_lock.toml。
 *
 * 用法：node scripts/check-migrations.mjs [rootDir]
 * 退出码：0 通过；1 违反上述规则。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_DIR_NAME = /^\d{14}_[a-z0-9_]+$/;

/** 返回 { skipped: boolean, errors: string[] }。 */
export function checkMigrations(root) {
  const prismaDir = join(root, 'packages', 'database', 'prisma');
  const schemaPath = join(prismaDir, 'schema.prisma');
  if (!existsSync(schemaPath)) {
    return { skipped: true, errors: [] };
  }

  const errors = [];
  const migrationsDir = join(prismaDir, 'migrations');
  if (!existsSync(migrationsDir)) {
    return { skipped: false, errors: ['schema.prisma 已存在但缺少 migrations/ 目录（未提交 Migration）'] };
  }

  const entries = readdirSync(migrationsDir, { withFileTypes: true });
  const migrationDirs = entries.filter((e) => e.isDirectory());
  if (migrationDirs.length === 0) {
    errors.push('schema.prisma 已存在但 migrations/ 为空（未提交 Migration）');
  }
  if (!entries.some((e) => e.isFile() && e.name === 'migration_lock.toml')) {
    errors.push('缺少 migrations/migration_lock.toml');
  }

  for (const dir of migrationDirs) {
    if (!MIGRATION_DIR_NAME.test(dir.name)) {
      errors.push(`Migration 目录名不符合 <14位时间戳>_<名称>: ${dir.name}`);
      continue;
    }
    const sqlPath = join(migrationsDir, dir.name, 'migration.sql');
    if (!existsSync(sqlPath)) {
      errors.push(`${dir.name}: 缺少 migration.sql`);
    } else if (statSync(sqlPath).size === 0 || readFileSync(sqlPath, 'utf8').trim() === '') {
      errors.push(`${dir.name}: migration.sql 为空`);
    }
  }

  return { skipped: false, errors };
}

function main(argv) {
  const root = argv[2] ?? process.cwd();
  const { skipped, errors } = checkMigrations(root);
  if (skipped) {
    console.log('Migration 检查跳过：packages/database/prisma/schema.prisma 尚未落地（DB-01 引入）');
  } else if (errors.length === 0) {
    console.log('Migration 检查通过');
  } else {
    for (const e of errors) console.error(`Migration 检查失败：${e}`);
  }
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv);
}
