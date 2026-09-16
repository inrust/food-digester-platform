import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { checkMigrationSource } from './check-migration-source.mjs';

export function databaseUrl(secret, caPath) {
  if (
    !secret ||
    secret.engine !== 'postgres' ||
    !secret.host ||
    !secret.username ||
    !secret.password ||
    !secret.dbname
  ) {
    throw new Error('Incomplete PostgreSQL secret');
  }
  const url = new URL('postgresql://localhost');
  url.hostname = secret.host;
  url.port = String(secret.port ?? 5432);
  url.username = secret.username;
  url.password = secret.password;
  url.pathname = `/${secret.dbname}`;
  // Prisma's schema engine uses require + strict, not libpq's verify-full mode.
  url.searchParams.set('sslmode', 'require');
  url.searchParams.set('sslaccept', 'strict');
  url.searchParams.set('sslcert', caPath);
  url.searchParams.set('sslrootcert', caPath);
  return url.toString();
}

async function main() {
  const sourceCommit = readFileSync('migration-source-commit.txt', 'utf8').trim();
  checkMigrationSource(process.env.FDP_EXPECTED_SOURCE_COMMIT, sourceCommit);
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) throw new Error('DB_SECRET_ARN required');
  const caPath = resolve('rds-ca-bundle.pem');
  const ca = readFileSync(caPath, 'utf8');
  const fetched = spawnSync(
    'aws',
    ['secretsmanager', 'get-secret-value', '--secret-id', secretArn, '--query', 'SecretString', '--output', 'text'],
    { encoding: 'utf8' },
  );
  if (fetched.status !== 0) throw new Error('Secret retrieval failed');
  const secret = JSON.parse(fetched.stdout);
  const url = databaseUrl(secret, caPath);
  // Never relay Prisma/driver errors: connection URLs can include credentials.
  const migrated = spawnSync('pnpm', ['--filter', '@fdp/database', 'exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });
  if (migrated.status !== 0)
    throw new Error('Migration failed; inspect database migration state using a separate approved diagnostic');
  const require = createRequire(resolve('packages/database/package.json'));
  const { Client } = require('pg');
  const client = new Client({
    host: secret.host,
    port: secret.port ?? 5432,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl: { ca, rejectUnauthorized: true },
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(readFileSync('packages/database/prisma/seed.sql', 'utf8'));
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  console.log(
    JSON.stringify({
      kind: 'fdp-database-migration/v1',
      sourceCommit,
      buildId: process.env.CODEBUILD_BUILD_ID,
      migrations: 'PASS',
      dictionarySeed: 'PASS',
    }),
  );
}
if (process.argv[1]?.endsWith('/run-database-migrations.mjs')) {
  main().catch(() => {
    console.error('Database migration runner failed (details redacted)');
    process.exitCode = 1;
  });
}
