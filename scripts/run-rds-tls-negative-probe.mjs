import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { checkMigrationSource } from './check-migration-source.mjs';

class ProbeFailure extends Error {
  constructor(stage) {
    super(stage);
    this.stage = stage;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new ProbeFailure('runner-configuration');
  return value;
}

function fetchSecret(secretArn) {
  const fetched = spawnSync(
    'aws',
    ['secretsmanager', 'get-secret-value', '--secret-id', secretArn, '--query', 'SecretString', '--output', 'text'],
    { encoding: 'utf8' },
  );
  if (fetched.status !== 0) throw new ProbeFailure('secret-retrieval');
  try {
    const secret = JSON.parse(fetched.stdout);
    if (!secret?.host || !secret?.username || !secret?.password || !secret?.dbname) throw new Error('shape');
    return secret;
  } catch {
    throw new ProbeFailure('secret-shape');
  }
}

function connection(secret, ssl) {
  return {
    host: secret.host,
    port: secret.port ?? 5432,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    connectionTimeoutMillis: 10_000,
    ssl,
  };
}

function isCertificateFailure(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return (
    /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_GET_ISSUER/u.test(code) ||
    /certificate|self.signed|unable to verify|altname|hostname/u.test(message.toLowerCase())
  );
}

async function expectCertificateRejection(Client, config, stage) {
  const client = new Client(config);
  try {
    await client.connect();
  } catch (error) {
    if (isCertificateFailure(error))
      return { rejected: true, errorCode: String(error?.code ?? 'TLS_CERTIFICATE_ERROR') };
    throw new ProbeFailure(`${stage}-non-certificate-failure`);
  } finally {
    await client.end().catch(() => undefined);
  }
  throw new ProbeFailure(`${stage}-unexpected-success`);
}

async function expectPlaintextRejection(Client, config) {
  const client = new Client(config);
  try {
    await client.connect();
  } catch {
    return { rejected: true };
  } finally {
    await client.end().catch(() => undefined);
  }
  throw new ProbeFailure('plaintext-unexpected-success');
}

async function main() {
  const sourceCommit = readFileSync('migration-source-commit.txt', 'utf8').trim();
  try {
    checkMigrationSource(required('FDP_EXPECTED_SOURCE_COMMIT'), sourceCommit);
  } catch {
    throw new ProbeFailure('source-approval');
  }

  const secret = fetchSecret(required('DB_SECRET_ARN'));
  const ca = readFileSync(resolve('rds-ca-bundle.pem'), 'utf8');
  const require = createRequire(resolve('packages/database/package.json'));
  const { Client } = require('pg');

  const positive = new Client(connection(secret, { ca, rejectUnauthorized: true }));
  let tls;
  try {
    await positive.connect();
    const result = await positive.query(
      `SELECT ssl, version IS NOT NULL AS has_version, cipher IS NOT NULL AS has_cipher
       FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
    );
    tls = result.rows[0];
    if (tls?.ssl !== true || tls?.has_version !== true || tls?.has_cipher !== true) {
      throw new ProbeFailure('strict-tls-observation');
    }
  } finally {
    await positive.end().catch(() => undefined);
  }

  const wrongCa = await expectCertificateRejection(
    Client,
    connection(secret, { ca: rootCertificates[0], rejectUnauthorized: true }),
    'wrong-ca',
  );
  const hostnameMismatch = await expectCertificateRejection(
    Client,
    connection(secret, { ca, rejectUnauthorized: true, servername: 'hostname-mismatch.invalid' }),
    'hostname-mismatch',
  );
  const plaintext = await expectPlaintextRejection(Client, connection(secret, false));

  console.log(
    JSON.stringify({
      kind: 'fdp-rds-tls-negative-probe/v1',
      sourceCommit,
      buildId: process.env.CODEBUILD_BUILD_ID,
      status: 'PASS',
      strictTls: { connected: true, ssl: tls.ssl, versionObserved: tls.has_version, cipherObserved: tls.has_cipher },
      wrongCa,
      hostnameMismatch,
      plaintext,
    }),
  );
}

main().catch((error) => {
  const stage = error instanceof ProbeFailure ? error.stage : 'unknown';
  console.error(JSON.stringify({ kind: 'fdp-rds-tls-negative-probe-failure/v1', stage }));
  process.exitCode = 1;
});
