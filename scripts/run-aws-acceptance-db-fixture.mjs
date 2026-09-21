import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { checkMigrationSource } from './check-migration-source.mjs';

class FixtureFailure extends Error {
  constructor(stage, codes = []) {
    super(stage);
    this.stage = stage;
    this.codes = codes;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new FixtureFailure('runner-configuration');
  return value;
}

function safeCodes(value) {
  const text = typeof value === 'string' ? value : '';
  return [...new Set(text.match(/\b(?:P\d{4}|[0-9A-Z]{5})\b/gu) ?? [])].slice(0, 8);
}

function loadFixture() {
  let fixture;
  try {
    fixture = JSON.parse(Buffer.from(required('FDP_ACCEPTANCE_FIXTURE_B64'), 'base64url').toString('utf8'));
  } catch {
    throw new FixtureFailure('fixture-shape');
  }
  const fields = ['deviceId', 'serialNumber', 'model', 'hardwareVersion', 'manufacturer', 'manufactureDate', 'tokenId'];
  if (fields.some((field) => typeof fixture[field] !== 'string' || fixture[field].length === 0)) {
    throw new FixtureFailure('fixture-shape');
  }
  if (!/^[a-f0-9]{64}$/u.test(fixture.tokenHash ?? '')) throw new FixtureFailure('fixture-shape');
  if (!Number.isFinite(Date.parse(fixture.tokenExpiresAt ?? ''))) throw new FixtureFailure('fixture-shape');
  return fixture;
}

function fetchSecret(secretArn) {
  const fetched = spawnSync(
    'aws',
    ['secretsmanager', 'get-secret-value', '--secret-id', secretArn, '--query', 'SecretString', '--output', 'text'],
    { encoding: 'utf8' },
  );
  if (fetched.status !== 0) throw new FixtureFailure('secret-retrieval');
  try {
    const secret = JSON.parse(fetched.stdout);
    if (!secret?.host || !secret?.username || !secret?.password || !secret?.dbname) throw new Error('shape');
    return secret;
  } catch {
    throw new FixtureFailure('secret-shape');
  }
}

async function main() {
  const sourceCommit = readFileSync('migration-source-commit.txt', 'utf8').trim();
  try {
    checkMigrationSource(required('FDP_EXPECTED_SOURCE_COMMIT'), sourceCommit);
  } catch {
    throw new FixtureFailure('source-approval');
  }

  const fixture = loadFixture();
  const secret = fetchSecret(required('DB_SECRET_ARN'));
  const require = createRequire(resolve('packages/database/package.json'));
  const { Client } = require('pg');
  const client = new Client({
    host: secret.host,
    port: secret.port ?? 5432,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl: { ca: readFileSync(resolve('rds-ca-bundle.pem'), 'utf8'), rejectUnauthorized: true },
  });

  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO devices
       (id, serial_number, model, hardware_version, manufacturer, manufacture_date, lifecycle_status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::date, 'PendingOnboarding', CURRENT_TIMESTAMP)`,
      [
        fixture.deviceId,
        fixture.serialNumber,
        fixture.model,
        fixture.hardwareVersion,
        fixture.manufacturer,
        fixture.manufactureDate,
      ],
    );
    await client.query(
      `INSERT INTO onboarding_tokens (id, token_hash, serial_number, expires_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz)`,
      [fixture.tokenId, fixture.tokenHash, fixture.serialNumber, fixture.tokenExpiresAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new FixtureFailure('fixture-seed', safeCodes(error?.code));
  } finally {
    await client.end().catch(() => undefined);
  }

  console.log(
    JSON.stringify({
      kind: 'fdp-aws-acceptance-fixture/v1',
      sourceCommit,
      buildId: process.env.CODEBUILD_BUILD_ID,
      deviceId: fixture.deviceId,
      serialNumber: fixture.serialNumber,
      tokenId: fixture.tokenId,
      status: 'SEEDED',
    }),
  );
}

main().catch((error) => {
  const receipt =
    error instanceof FixtureFailure
      ? { kind: 'fdp-aws-acceptance-fixture-failure/v1', stage: error.stage, codes: error.codes }
      : { kind: 'fdp-aws-acceptance-fixture-failure/v1', stage: 'unknown', codes: [] };
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
});
