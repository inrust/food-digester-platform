import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot, compareMigrations, validateManifest } from './qa09-db-readonly-probe.mjs';
import { prepareProbe } from './prepare-qa09-db-readonly-probe.mjs';
const manifest = {
  sourceCommit: 'a'.repeat(40),
  schemaSha256: 'b'.repeat(64),
  tables: ['users'],
  migrations: [{ name: '20260929120000_csr_onboarding', checksum: 'c'.repeat(64) }],
};
const applied = {
  migration_name: manifest.migrations[0].name,
  checksum: 'c'.repeat(64),
  finished_at: '2026-10-02',
  rolled_back_at: null,
};
test('fixed manifest rejects unsafe SQL identifiers, missing hash and duplicates', () => {
  validateManifest(manifest);
  for (const m of [
    { ...manifest, tables: ['users; DROP TABLE users'] },
    { ...manifest, tables: ['users', 'users'] },
    { ...manifest, schemaSha256: null },
    { ...manifest, cleanupPrefix: 'arbitrary' },
    { ...manifest, migrations: [...manifest.migrations, ...manifest.migrations] },
  ])
    assert.throws(() => validateManifest(m));
});
test('migration comparison distinguishes missing, tampered, unfinished and rolled-back migrations', () => {
  assert.equal(compareMigrations(manifest.migrations, [applied]).status, 'PASS');
  assert.equal(compareMigrations(manifest.migrations, []).status, 'BLOCKED');
  assert.equal(compareMigrations(manifest.migrations, [{ ...applied, checksum: 'd'.repeat(64) }]).status, 'BLOCKED');
  assert.equal(compareMigrations(manifest.migrations, [{ ...applied, finished_at: null }]).status, 'BLOCKED');
  assert.equal(
    compareMigrations(manifest.migrations, [{ ...applied, rolled_back_at: '2026-10-02' }]).status,
    'BLOCKED',
  );
});
function mockClient({ writable = false, failCounts = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('current_database()'))
        return { rows: [{ database: 'fdp', read_only: writable ? 'off' : 'on' }] };
      if (sql.includes('_prisma_migrations')) return { rows: [applied] };
      if (sql.includes('to_regclass')) return { rows: [{ relation: 'users' }] };
      if (sql.includes('count(*)::text AS count')) {
        if (failCounts) throw Error('QUERY_FAILED');
        return { rows: [{ count: '2' }] };
      }
      if (sql.includes('distinct_customers'))
        return { rows: [{ total: '2', distinct_customers: '0', platform_scopes: '2' }] };
      return { rows: [] };
    },
  };
}
test('snapshot uses repeatable read/read only, timeouts, fixed SELECTs and always rolls back', async () => {
  const c = mockClient();
  const result = await collectSnapshot(c, manifest);
  assert.equal(result.migrationComparison.status, 'PASS');
  assert.equal(result.counts.users.count, '2');
  assert.equal(c.queries[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(c.queries.at(-1), 'ROLLBACK');
  assert.ok(c.queries.some((q) => q.includes('statement_timeout')));
  assert.ok(c.queries.every((q) => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT)\b/.test(q)));
});
test('writable transaction rejected before business queries and rolled back', async () => {
  const c = mockClient({ writable: true });
  await assert.rejects(() => collectSnapshot(c, manifest), /WRONG_DATABASE_OR_WRITABLE_TRANSACTION/);
  assert.equal(c.queries.at(-1), 'ROLLBACK');
  assert.ok(!c.queries.some((q) => q.includes('_prisma_migrations')));
});
test('query failure rolls back instead of yielding partial PASS', async () => {
  const c = mockClient({ failCounts: true });
  await assert.rejects(() => collectSnapshot(c, manifest), /QUERY_FAILED/);
  assert.equal(c.queries.at(-1), 'ROLLBACK');
});
test('dedicated query project never changes migration project or passes StartBuild overrides', () => {
  const p = prepareProbe();
  assert.equal(p.project.name, 'fdp-test-qa09-readonly-runner');
  assert.equal(p.project.source.type, 'NO_SOURCE');
  assert.deepEqual(Object.keys(p.request), ['projectName']);
  assert.equal(p.project.timeoutInMinutes, 5);
  assert.equal(p.project.autoRetryLimit, 0);
  const commands = JSON.parse(p.project.source.buildspec).phases;
  assert.ok(!JSON.stringify(commands).includes('migrate deploy'));
  assert.equal(p.project.vpcConfig.securityGroupIds[0], 'sg-081d9a3ee5f6011e9');
  assert.equal(p.manifest.migrations.length, 40);
});

test('legacy onboarding rows without CSR columns require reconciliation before migration', async () => {
  const c = mockClient();
  const result = await collectSnapshot(c, { ...manifest, tables: ['onboarding_requests'] });
  assert.equal(result.onboardingMigrationPrecheck.csrColumnsPresent, false);
  assert.equal(result.onboardingMigrationPrecheck.legacyRequestsWithoutCsr, '2');
  assert.equal(result.onboardingMigrationPrecheck.status, 'RECONCILIATION_REQUIRED');
});
