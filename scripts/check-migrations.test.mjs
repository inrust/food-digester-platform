/**
 * ENG-02 check-migrations 失败示例测试。
 * 运行：node --test scripts/check-migrations.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkMigrations } from './check-migrations.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'fdp-migrations-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const SCHEMA = 'model Device { id String @id }';
const LOCK = 'provider = "postgresql"';
const SQL = 'CREATE TABLE "devices" ("id" TEXT PRIMARY KEY);';
const DIR = 'packages/database/prisma';

test('当前仓库（DB-01 已落地）Migration 结构通过', () => {
  const root = new URL('..', import.meta.url).pathname;
  const { skipped, errors } = checkMigrations(root);
  assert.equal(skipped, false);
  assert.deepEqual(errors, []);
});

test('schema.prisma 未落地时跳过并通过（骨架期行为）', () => {
  const root = fixture({});
  const { skipped, errors } = checkMigrations(root);
  assert.equal(skipped, true);
  assert.deepEqual(errors, []);
});

test('失败示例：Schema 已存在但无任何 Migration（未提交 Migration）', () => {
  const root = fixture({ [`${DIR}/schema.prisma`]: SCHEMA });
  const { errors } = checkMigrations(root);
  assert.ok(errors.some((e) => e.includes('未提交 Migration')));
});

test('失败示例：migrations/ 为空且缺少 migration_lock.toml', () => {
  const root = fixture({
    [`${DIR}/schema.prisma`]: SCHEMA,
    [`${DIR}/migrations/.gitkeep`]: '',
  });
  const { errors } = checkMigrations(root);
  assert.ok(errors.some((e) => e.includes('migrations/ 为空')));
  assert.ok(errors.some((e) => e.includes('migration_lock.toml')));
});

test('失败示例：Migration 目录名非法与空 migration.sql', () => {
  const root = fixture({
    [`${DIR}/schema.prisma`]: SCHEMA,
    [`${DIR}/migrations/migration_lock.toml`]: LOCK,
    [`${DIR}/migrations/init/migration.sql`]: SQL,
    [`${DIR}/migrations/20260101000000_empty/migration.sql`]: '',
  });
  const { errors } = checkMigrations(root);
  assert.ok(errors.some((e) => e.includes('目录名不符合')));
  assert.ok(errors.some((e) => e.includes('migration.sql 为空')));
});

test('合法 Migration 结构通过', () => {
  const digest = createHash('sha256').update(SCHEMA).digest('hex');
  const root = fixture({
    [`${DIR}/schema.prisma`]: SCHEMA,
    [`${DIR}/migrations/migration_lock.toml`]: LOCK,
    [`${DIR}/migrations/20260101000000_init/migration.sql`]: SQL,
    [`${DIR}/migrations/20260101000000_init/schema.sha256`]: digest,
  });
  const { skipped, errors } = checkMigrations(root);
  assert.equal(skipped, false);
  assert.deepEqual(errors, []);
});

test('失败示例：已有旧 Migration 但 Schema 已变化且未登记快照', () => {
  const root = fixture({
    [`${DIR}/schema.prisma`]: 'model Device { id String @id\n name String }',
    [`${DIR}/migrations/migration_lock.toml`]: LOCK,
    [`${DIR}/migrations/20260101000000_init/migration.sql`]: SQL,
  });
  const { errors } = checkMigrations(root);
  assert.ok(errors.some((e) => e.includes('Schema 快照')));
});
