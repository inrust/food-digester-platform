#!/usr/bin/env node
/* global process, console */
/**
 * 在两个隔离 PGlite 实例中分别应用实际 Migration 与 Prisma 期望 SQL，比较最终结构。
 * 自定义约束/触发器允许作为实际库的增强；Prisma 声明的表、列、键和索引必须完整存在。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const root = process.argv[2] ?? process.cwd();
const prismaDir = join(root, 'packages/database/prisma');
const migrationsDir = join(prismaDir, 'migrations');

function readMigrations() {
  return readdirSync(migrationsDir)
    .filter((entry) => /^\d{14}_[a-z0-9_]+$/.test(entry))
    .sort()
    .map((entry) => readFileSync(join(migrationsDir, entry, 'migration.sql'), 'utf8'))
    .join('\n');
}

function expectedSql() {
  return execFileSync(
    join(root, 'packages', 'database', 'node_modules', '.bin', 'prisma'),
    ['migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'],
    { cwd: join(root, 'packages', 'database'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function columns(db) {
  const { rows } = await db.query(`
    SELECT table_name, column_name, udt_name, is_nullable, column_default,
           character_maximum_length, numeric_precision, numeric_scale, datetime_precision
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position
  `);
  return rows;
}

async function constraints(db) {
  const { rows } = await db.query(`
    SELECT cls.relname AS table_name,
           con.conname AS constraint_name,
           CASE con.contype
             WHEN 'p' THEN 'PRIMARY KEY'
             WHEN 'u' THEN 'UNIQUE'
             WHEN 'f' THEN 'FOREIGN KEY'
           END AS constraint_type,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE ns.nspname = 'public' AND con.contype IN ('p', 'u', 'f')
     ORDER BY cls.relname, con.conname
  `);
  return rows;
}

async function indexes(db) {
  const { rows } = await db.query(`
    SELECT tablename, indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
     ORDER BY tablename, indexname
  `);
  return rows;
}

function key(row) {
  return JSON.stringify(row);
}

function assertSameColumns(actual, expected) {
  const a = new Set(actual.map(key));
  const e = new Set(expected.map(key));
  const missing = [...e].filter((item) => !a.has(item));
  const extra = [...a].filter((item) => !e.has(item));
  if (missing.length || extra.length) {
    throw new Error(
      `Prisma/Migration 列结构漂移：missing=${missing.slice(0, 5).join(', ')} extra=${extra.slice(0, 5).join(', ')}`,
    );
  }
}

function assertExpectedSubset(actual, expected, label) {
  const a = new Set(actual.map(key));
  const missing = expected.map(key).filter((item) => !a.has(item));
  if (missing.length) throw new Error(`Prisma/Migration ${label}漂移：missing=${missing.slice(0, 8).join(', ')}`);
}

const actualDb = new PGlite({ extensions: { btree_gist } });
const expectedDb = new PGlite();
try {
  await actualDb.exec(readMigrations());
  await expectedDb.exec(expectedSql());
  assertSameColumns(await columns(actualDb), await columns(expectedDb));
  assertExpectedSubset(await constraints(actualDb), await constraints(expectedDb), '键约束');
  assertExpectedSubset(await indexes(actualDb), await indexes(expectedDb), '索引');
  console.log('Migration 应用结果与 Prisma Schema 一致');
} finally {
  await actualDb.close();
  await expectedDb.close();
}
