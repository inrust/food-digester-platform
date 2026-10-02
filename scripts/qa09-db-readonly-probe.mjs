import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DB_TARGET = {
  accountId: '065986019555',
  region: 'ap-southeast-1',
  host: 'fdp-test-db.c30ie84saulu.ap-southeast-1.rds.amazonaws.com',
  database: 'fdp',
  project: 'fdp-test-qa09-readonly-runner',
  secretArn: 'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-rds-credentials-hBessK',
};
export function validateManifest(manifest) {
  if (
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') ||
    !/^[a-f0-9]{64}$/.test(manifest.schemaSha256 ?? '') ||
    !Array.isArray(manifest.migrations) ||
    !manifest.migrations.length ||
    !Array.isArray(manifest.tables) ||
    !manifest.tables.length
  )
    throw Error('INVALID_MANIFEST');
  if (manifest.migrations.length > 100 || manifest.tables.length > 100) throw Error('MANIFEST_TOO_LARGE');
  if (manifest.cleanupPrefix !== undefined && !/^qa09-[0-9a-f]{16}$/.test(manifest.cleanupPrefix))
    throw Error('INVALID_CLEANUP_PREFIX');
  if (
    manifest.migrations.some((m) => !/^\d{14}_[a-z0-9_]+$/.test(m.name) || !/^[a-f0-9]{64}$/.test(m.checksum)) ||
    manifest.tables.some((t) => !/^[a-z][a-z0-9_]*$/.test(t))
  )
    throw Error('INVALID_MANIFEST');
  if (
    new Set(manifest.tables).size !== manifest.tables.length ||
    new Set(manifest.migrations.map((m) => m.name)).size !== manifest.migrations.length
  )
    throw Error('DUPLICATE_MANIFEST_ENTRY');
}
export function compareMigrations(expected, actual) {
  const applied = actual.filter((m) => m.finished_at && !m.rolled_back_at);
  const missing = expected.filter((m) => !applied.some((a) => a.migration_name === m.name)).map((m) => m.name);
  const mismatched = expected
    .filter((m) => applied.some((a) => a.migration_name === m.name && a.checksum !== m.checksum))
    .map((m) => m.name);
  const unresolved = actual.filter((m) => !m.finished_at && !m.rolled_back_at).map((m) => m.migration_name);
  const unexpected = applied
    .filter((m) => !expected.some((e) => e.name === m.migration_name))
    .map((m) => m.migration_name);
  return {
    status: missing.length || mismatched.length || unresolved.length || unexpected.length ? 'BLOCKED' : 'PASS',
    missing,
    mismatched,
    unresolved,
    unexpected,
  };
}
export async function collectSnapshot(client, manifest) {
  validateManifest(manifest);
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    const identity = (
      await client.query(
        "SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only, transaction_timestamp() AS snapshot_at",
      )
    ).rows[0];
    if (identity.database !== DB_TARGET.database || identity.read_only !== 'on')
      throw Error('WRONG_DATABASE_OR_WRITABLE_TRANSACTION');
    const migrations = (
      await client.query(
        'SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count FROM public."_prisma_migrations" ORDER BY started_at, migration_name',
      )
    ).rows;
    const counts = {};
    for (const table of manifest.tables) {
      const found = (await client.query('SELECT to_regclass($1) AS relation', [`public.${table}`])).rows[0].relation;
      counts[table] = found
        ? {
            status: 'OBSERVED',
            count: (await client.query(`SELECT count(*)::text AS count FROM public."${table}"`)).rows[0].count,
          }
        : { status: 'MISSING', count: null };
    }
    const roles = (
      await client.query(
        'SELECT r.code, count(ur.user_id)::text AS members FROM public.roles r LEFT JOIN public.user_roles ur ON ur.role_code = r.code GROUP BY r.code ORDER BY r.code',
      )
    ).rows;
    const scopeCounts = (
      await client.query(
        'SELECT count(*)::text AS total, count(DISTINCT customer_id)::text AS distinct_customers, count(*) FILTER (WHERE customer_id IS NULL)::text AS platform_scopes FROM public.user_scopes',
      )
    ).rows[0];
    const onboardingColumns = (
      await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'onboarding_requests' ORDER BY column_name",
      )
    ).rows.map((r) => r.column_name);
    const csrColumnsPresent = ['csr_pem', 'public_key_fingerprint'].every((c) => onboardingColumns.includes(c));
    const legacyRequestsWithoutCsr = csrColumnsPresent
      ? (
          await client.query(
            'SELECT count(*)::text AS count FROM public.onboarding_requests WHERE csr_pem IS NULL OR public_key_fingerprint IS NULL',
          )
        ).rows[0].count
      : (counts.onboarding_requests?.count ?? null);
    const onboardingMigrationPrecheck = {
      csrColumnsPresent,
      legacyRequestsWithoutCsr,
      status: legacyRequestsWithoutCsr === '0' ? 'PASS' : 'RECONCILIATION_REQUIRED',
    };
    const legacyOnboardingAssociations = csrColumnsPresent
      ? []
      : (
          await client.query(
            'SELECT r.id AS request_id, r.status AS request_status, j.id AS job_id, j.status AS job_status, d.id AS device_id, d.lifecycle_status AS device_status, j.issued_certificate_id FROM public.onboarding_requests r LEFT JOIN public.onboarding_provisioning_jobs j ON j.request_id = r.id LEFT JOIN public.devices d ON d.serial_number = r.serial_number ORDER BY r.id LIMIT 100',
          )
        ).rows;
    const cleanupCounts = {};
    if (manifest.cleanupPrefix) {
      for (const table of ['customers', 'sites']) {
        cleanupCounts[table] = (
          await client.query(
            `SELECT count(*)::text AS total, count(*) FILTER (WHERE deleted_at IS NULL)::text AS visible FROM public."${table}" WHERE name LIKE $1`,
            [manifest.cleanupPrefix + '-%'],
          )
        ).rows[0];
      }
      cleanupCounts.users = (
        await client.query('SELECT count(*)::text AS total FROM public.users WHERE email LIKE $1', [
          manifest.cleanupPrefix + '-%',
        ])
      ).rows[0];
    }
    return {
      onboardingMigrationPrecheck,
      legacyOnboardingAssociations,
      cleanupCounts,
      identity,
      migrations,
      migrationComparison: compareMigrations(manifest.migrations, migrations),
      counts,
      roles,
      scopeCounts,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}
function aws(args) {
  const result = spawnSync('aws', [...args, '--region', DB_TARGET.region, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  });
  if (result.status !== 0) throw Error('AWS_READ_FAILED');
  return JSON.parse(result.stdout);
}
async function main() {
  const identity = aws(['sts', 'get-caller-identity']);
  if (
    identity.Account !== DB_TARGET.accountId ||
    !identity.Arn?.startsWith(`arn:aws:sts::${DB_TARGET.accountId}:assumed-role/fdp-test-migration-runner-role/`) ||
    process.env.DB_SECRET_ARN !== DB_TARGET.secretArn ||
    !process.env.CODEBUILD_BUILD_ID?.startsWith(`${DB_TARGET.project}:`)
  )
    throw Error('WRONG_TEST_RUNNER');
  if (
    createHash('sha256')
      .update(readFileSync(new URL(import.meta.url)))
      .digest('hex') !== process.env.QA09_DB_PROBE_SHA256
  )
    throw Error('PROBE_HASH_MISMATCH');
  const manifest = JSON.parse(Buffer.from(process.env.QA09_DB_MANIFEST_B64 ?? '', 'base64').toString('utf8'));
  validateManifest(manifest);
  const secret = JSON.parse(
    aws(['secretsmanager', 'get-secret-value', '--secret-id', DB_TARGET.secretArn]).SecretString,
  );
  if (secret.host !== DB_TARGET.host || secret.dbname !== DB_TARGET.database || (secret.port ?? 5432) !== 5432)
    throw Error('WRONG_DATABASE_SECRET');
  const { Client } = createRequire(resolve('package.json'))('pg');
  const client = new Client({
    host: secret.host,
    port: 5432,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    connectionTimeoutMillis: 10000,
    ssl: { ca: readFileSync('rds-ca-bundle.pem', 'utf8'), rejectUnauthorized: true },
  });
  let snapshot;
  try {
    await client.connect();
    snapshot = await collectSnapshot(client, manifest);
  } finally {
    await client.end();
  }
  console.log(
    JSON.stringify({
      kind: 'fdp-qa09-db-readonly/v1',
      executedAt: new Date().toISOString(),
      sourceCommit: manifest.sourceCommit,
      probeSha256: process.env.QA09_DB_PROBE_SHA256,
      buildId: process.env.CODEBUILD_BUILD_ID,
      target: DB_TARGET,
      businessDataWrites: false,
      ...snapshot,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        kind: 'fdp-qa09-db-readonly-failure/v1',
        code: /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : 'PROBE_FAILED',
      }),
    );
    process.exitCode = 1;
  });
