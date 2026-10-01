import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationSource } from './check-migration-source.mjs';
import { databaseUrl, expectedTablesFromSchema } from './run-database-migrations.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('migration source requires exact approved commit', () => {
  const sha = 'a'.repeat(40);
  checkMigrationSource(sha, sha);
  for (const expected of [undefined, 'NOT_APPROVED', 'main', 'a'.repeat(39)])
    assert.throws(() => checkMigrationSource(expected, sha));
  assert.throws(() => checkMigrationSource(sha, 'b'.repeat(40)));
});
test('migration connection requires complete secret and verified TLS; special credentials are encoded', () => {
  const secret = {
    engine: 'postgres',
    host: 'private.rds.amazonaws.com',
    username: 'user',
    password: 'a@:/?#',
    dbname: 'fdp',
  };
  const url = new URL(databaseUrl(secret));
  assert.equal(decodeURIComponent(url.password), secret.password);
  assert.equal(url.searchParams.get('sslmode'), 'require');
  assert.equal(url.searchParams.get('sslaccept'), null);
  assert.equal(url.searchParams.get('sslcert'), null);
  assert.equal(url.searchParams.get('sslrootcert'), null);
  for (const key of ['engine', 'host', 'username', 'password', 'dbname'])
    assert.throws(() => databaseUrl({ ...secret, [key]: undefined }));
});
test('database verification derives every mapped Prisma table', () => {
  const schema = readFileSync('packages/database/prisma/schema.prisma', 'utf8');
  const tables = expectedTablesFromSchema(schema);
  assert.equal(tables.length, 58);
  assert.ok(tables.includes('device_public_keys'));
  assert.ok(tables.includes('onboarding_proof_nonces'));
  assert.ok(tables.includes('customers'));
  assert.ok(tables.includes('device_activity_export_jobs'));
  assert.ok(tables.includes('audit_logs'));
  assert.equal(new Set(tables).size, tables.length);
});
test('runner without approved source fails without reporting credentials or driver details', () => {
  const result = spawnSync(process.execPath, ['scripts/run-database-migrations.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, FDP_EXPECTED_SOURCE_COMMIT: 'NOT_APPROVED' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    kind: 'fdp-database-migration-failure/v1',
    stage: 'source-approval',
    codes: [],
  });
  assert.doesNotMatch(result.stderr, /postgresql:|password|driver/iu);
});
test('source packager archives committed tree, includes exact SHA and refuses overwriting ZIP', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'fdp-migration-test-'));
  try {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const output = resolve(dir, 'source.zip');
    const args = ['scripts/package-migration-source.mjs', sha, output];
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('unzip', ['-p', output, 'migration-source-commit.txt'], { encoding: 'utf8' }).stdout.trim(),
      sha,
    );
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
