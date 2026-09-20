import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { checkMigrationSource } from './check-migration-source.mjs';

class MigrationFailure extends Error {
  constructor(stage, codes = []) {
    super(stage);
    this.stage = stage;
    this.codes = codes;
  }
}

function safeCodes(value) {
  const text = typeof value === 'string' ? value : '';
  return [...new Set(text.match(/\b(?:P\d{4}|[0-9A-Z]{5})\b/gu) ?? [])].slice(0, 8);
}

export function databaseUrl(secret) {
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
  // Prisma requires encrypted transport. A strict CA/hostname probe using pg runs
  // immediately before Prisma because Prisma's engine rejects the RDS CA bundle
  // with P1011 when sslaccept=strict is enabled.
  url.searchParams.set('sslmode', 'require');
  return url.toString();
}

async function main() {
  let sourceCommit;
  try {
    sourceCommit = readFileSync('migration-source-commit.txt', 'utf8').trim();
    checkMigrationSource(process.env.FDP_EXPECTED_SOURCE_COMMIT, sourceCommit);
  } catch {
    throw new MigrationFailure('source-approval');
  }
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) throw new MigrationFailure('runner-configuration');
  const caPath = resolve('rds-ca-bundle.pem');
  const ca = readFileSync(caPath, 'utf8');
  const fetched = spawnSync(
    'aws',
    ['secretsmanager', 'get-secret-value', '--secret-id', secretArn, '--query', 'SecretString', '--output', 'text'],
    { encoding: 'utf8' },
  );
  if (fetched.status !== 0) throw new MigrationFailure('secret-retrieval');
  let secret;
  try {
    secret = JSON.parse(fetched.stdout);
  } catch {
    throw new MigrationFailure('secret-shape');
  }
  let url;
  try {
    url = databaseUrl(secret);
  } catch {
    throw new MigrationFailure('secret-shape');
  }
  const require = createRequire(resolve('packages/database/package.json'));
  const { Client } = require('pg');
  const connection = {
    host: secret.host,
    port: secret.port ?? 5432,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl: { ca, rejectUnauthorized: true },
  };
  const probe = new Client(connection);
  try {
    await probe.connect();
    await probe.query('SELECT 1');
  } catch (error) {
    throw new MigrationFailure('database-connect', safeCodes(error?.code));
  } finally {
    await probe.end().catch(() => undefined);
  }
  // Never relay Prisma/driver errors: connection URLs can include credentials.
  const migrated = spawnSync('pnpm', ['--filter', '@fdp/database', 'exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (migrated.status !== 0)
    throw new MigrationFailure('prisma-migrate', safeCodes(`${migrated.stdout ?? ''}\n${migrated.stderr ?? ''}`));
  const client = new Client(connection);
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(readFileSync('packages/database/prisma/seed.sql', 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new MigrationFailure('dictionary-seed', safeCodes(error?.code));
  } finally {
    await client.end().catch(() => undefined);
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
  main().catch((error) => {
    const receipt =
      error instanceof MigrationFailure
        ? { kind: 'fdp-database-migration-failure/v1', stage: error.stage, codes: error.codes }
        : { kind: 'fdp-database-migration-failure/v1', stage: 'unknown', codes: [] };
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  });
}
