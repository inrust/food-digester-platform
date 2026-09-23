import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { checkAdminBootstrapSource } from './check-admin-bootstrap-source.mjs';

const SUPER_ADMIN = 'PlatformSuperAdmin';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export class AdminBootstrapFailure extends Error {
  constructor(stage, codes = []) {
    super(stage);
    this.stage = stage;
    this.codes = codes;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function bootstrapConfirmation(email) {
  return `CREATE_FIRST_PLATFORM_SUPER_ADMIN:${sha256(email.trim().toLowerCase())}`;
}

export function bootstrapConfig(env) {
  const email = (env.FDP_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
  const displayName = (env.FDP_BOOTSTRAP_DISPLAY_NAME ?? '').trim();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new AdminBootstrapFailure('input-validation');
  if (displayName.length === 0 || displayName.length > 128) throw new AdminBootstrapFailure('input-validation');
  if (env.FDP_BOOTSTRAP_CONFIRMATION !== bootstrapConfirmation(email)) {
    throw new AdminBootstrapFailure('approval-binding');
  }
  return { email, displayName, emailSha256: sha256(email) };
}

function safeCodes(value) {
  const text = typeof value === 'string' ? value : '';
  return [...new Set(text.match(/\b(?:[A-Z][A-Za-z]+Exception|P\d{4}|[0-9A-Z]{5})\b/gu) ?? [])].slice(0, 8);
}

function runAws(args) {
  const result = spawnSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(safeCodes(result.stderr).join(','));
  try {
    return result.stdout.trim() === '' ? {} : JSON.parse(result.stdout);
  } catch {
    throw new Error('AWS_RESPONSE_INVALID');
  }
}

export async function executeAdminBootstrap(config, deps) {
  const state = await deps.preflight();
  if (state.databaseUserCount !== 0 || state.cognitoUserCount !== 0 || state.superAdminRoleExists !== true) {
    throw new AdminBootstrapFailure('pristine-precondition');
  }
  const userId = deps.randomId();
  const intentId = deps.randomId();
  await deps.startIntent({ intentId, userId, emailSha256: config.emailSha256 });
  let identity;
  try {
    identity = await deps.createIdentity({ email: config.email });
  } catch (error) {
    await deps
      .markFailure({ intentId, userId, stage: 'cognito-create', reconciliationRequired: false })
      .catch(() => {});
    throw new AdminBootstrapFailure('cognito-create', safeCodes(error?.message));
  }
  try {
    await deps.addToSuperAdminGroup({ username: identity.username });
  } catch (error) {
    let reconciliationRequired = false;
    try {
      await deps.deleteIdentity({ username: identity.username });
    } catch {
      reconciliationRequired = true;
    }
    await deps.markFailure({ intentId, userId, stage: 'cognito-group', reconciliationRequired }).catch(() => {});
    throw new AdminBootstrapFailure(
      reconciliationRequired ? 'cognito-compensation' : 'cognito-group',
      safeCodes(error?.message),
    );
  }
  try {
    await deps.commitDatabase({
      intentId,
      userId,
      email: config.email,
      emailSha256: config.emailSha256,
      displayName: config.displayName,
      cognitoSub: identity.cognitoSub,
    });
  } catch (error) {
    let reconciliationRequired = false;
    try {
      await deps.deleteIdentity({ username: identity.username });
    } catch {
      reconciliationRequired = true;
    }
    await deps.markFailure({ intentId, userId, stage: 'database-commit', reconciliationRequired }).catch(() => {});
    throw new AdminBootstrapFailure(
      reconciliationRequired ? 'cognito-compensation' : 'database-commit',
      safeCodes(error?.message),
    );
  }
  return { userId, emailSha256: config.emailSha256, role: SUPER_ADMIN };
}

async function main() {
  try {
    checkAdminBootstrapSource(
      process.env.FDP_EXPECTED_SOURCE_COMMIT,
      readFileSync('admin-bootstrap-source-commit.txt', 'utf8').trim(),
    );
  } catch {
    throw new AdminBootstrapFailure('source-approval');
  }
  const config = bootstrapConfig(process.env);
  const secretArn = process.env.DB_SECRET_ARN;
  const userPoolId = process.env.USER_POOL_ID;
  if (!secretArn || !userPoolId || !process.env.AWS_REGION) throw new AdminBootstrapFailure('runner-configuration');
  let secret;
  try {
    secret = runAws([
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      secretArn,
      '--query',
      'SecretString',
      '--output',
      'json',
    ]);
    if (typeof secret === 'string') secret = JSON.parse(secret);
  } catch (error) {
    throw new AdminBootstrapFailure('secret-retrieval', safeCodes(error?.message));
  }
  if (!secret?.host || !secret?.username || !secret?.password || !secret?.dbname) {
    throw new AdminBootstrapFailure('secret-shape');
  }
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
    await client.query("SELECT pg_advisory_lock(hashtext('fdp-admin-bootstrap-v1'))");
  } catch (error) {
    throw new AdminBootstrapFailure('database-connect', safeCodes(error?.code));
  }
  const aws = (args) => runAws(['cognito-idp', ...args, '--region', process.env.AWS_REGION, '--output', 'json']);
  const deps = {
    randomId: randomUUID,
    async preflight() {
      const database = await client.query(
        `SELECT
           (SELECT count(*)::int FROM "users") AS user_count,
           EXISTS (SELECT 1 FROM "roles" WHERE code = $1) AS role_exists`,
        [SUPER_ADMIN],
      );
      const cognito = aws(['list-users', '--user-pool-id', userPoolId, '--limit', '1']);
      aws(['get-group', '--user-pool-id', userPoolId, '--group-name', SUPER_ADMIN]);
      return {
        databaseUserCount: database.rows[0]?.user_count,
        cognitoUserCount: cognito.Users?.length ?? 0,
        superAdminRoleExists: database.rows[0]?.role_exists === true,
      };
    },
    async startIntent(input) {
      await client.query(
        `INSERT INTO "outbox_events"
          (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload, status, retry_count, created_at)
         VALUES ($1, 'COGNITO_ADMIN_RECONCILIATION', 'user', $2, $3, $4::jsonb, 'PENDING', 0, now())`,
        [
          input.intentId,
          input.userId,
          `cognito-bootstrap:${input.userId}`,
          JSON.stringify({ action: 'BOOTSTRAP_PLATFORM_SUPER_ADMIN', emailSha256: input.emailSha256 }),
        ],
      );
    },
    async createIdentity(input) {
      const response = aws([
        'admin-create-user',
        '--user-pool-id',
        userPoolId,
        '--username',
        input.email,
        '--desired-delivery-mediums',
        'EMAIL',
        '--user-attributes',
        `Name=email,Value=${input.email}`,
        'Name=email_verified,Value=true',
      ]);
      const username = response.User?.Username;
      const cognitoSub = response.User?.Attributes?.find((item) => item.Name === 'sub')?.Value;
      if (!username || !cognitoSub) throw new Error('COGNITO_RESPONSE_INVALID');
      return { username, cognitoSub };
    },
    async addToSuperAdminGroup(input) {
      aws([
        'admin-add-user-to-group',
        '--user-pool-id',
        userPoolId,
        '--username',
        input.username,
        '--group-name',
        SUPER_ADMIN,
      ]);
    },
    async deleteIdentity(input) {
      aws(['admin-delete-user', '--user-pool-id', userPoolId, '--username', input.username]);
    },
    async commitDatabase(input) {
      await client.query('BEGIN');
      try {
        const existing = await client.query('SELECT id FROM "users" FOR UPDATE');
        if (existing.rowCount !== 0) throw new Error('DATABASE_NOT_PRISTINE');
        await client.query(
          `INSERT INTO "users"
            (id, email, display_name, cognito_sub, status, mfa_enabled, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'INVITED', false, now(), now())`,
          [input.userId, input.email, input.displayName, input.cognitoSub],
        );
        await client.query(`INSERT INTO "user_roles" (user_id, role_code, created_at) VALUES ($1, $2, now())`, [
          input.userId,
          SUPER_ADMIN,
        ]);
        await client.query(
          `INSERT INTO "audit_logs"
            (id, actor_id, actor_role, object_type, object_id, action, reason, before_value, after_value,
             result, request_id, created_at)
           VALUES ($1, NULL, NULL, 'user', $2, 'user.bootstrap', 'initial controlled bootstrap',
             'null'::jsonb, $3::jsonb, 'SUCCESS', $4, now())`,
          [
            randomUUID(),
            input.userId,
            JSON.stringify({ emailSha256: input.emailSha256, roles: [SUPER_ADMIN], status: 'INVITED' }),
            process.env.CODEBUILD_BUILD_ID ?? null,
          ],
        );
        await client.query(
          `UPDATE "outbox_events"
             SET status = 'PUBLISHED', published_at = now(), last_error = NULL
           WHERE id = $1 AND status = 'PENDING'`,
          [input.intentId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },
    async markFailure(input) {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE "outbox_events"
             SET status = $2, retry_count = retry_count + 1, last_error = $3
           WHERE id = $1`,
          [
            input.intentId,
            input.reconciliationRequired ? 'PENDING' : 'FAILED',
            input.reconciliationRequired ? 'RECONCILIATION_REQUIRED' : 'COMPENSATED',
          ],
        );
        await client.query(
          `INSERT INTO "audit_logs"
            (id, actor_id, actor_role, object_type, object_id, action, reason, before_value, after_value,
             result, request_id, created_at)
           VALUES ($1, NULL, NULL, 'user', $2, 'user.bootstrap', $3,
             'null'::jsonb, $4::jsonb, 'FAILURE', $5, now())`,
          [
            randomUUID(),
            input.userId,
            input.stage,
            JSON.stringify({ reconciliationRequired: input.reconciliationRequired }),
            process.env.CODEBUILD_BUILD_ID ?? null,
          ],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },
  };
  try {
    const result = await executeAdminBootstrap(config, deps);
    console.log(
      JSON.stringify({
        kind: 'fdp-admin-bootstrap/v1',
        sourceCommit: process.env.FDP_EXPECTED_SOURCE_COMMIT,
        buildId: process.env.CODEBUILD_BUILD_ID,
        status: 'PASS',
        ...result,
      }),
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('fdp-admin-bootstrap-v1'))").catch(() => {});
    await client.end().catch(() => {});
  }
}

if (process.argv[1]?.endsWith('/run-admin-bootstrap.mjs')) {
  main().catch((error) => {
    const receipt =
      error instanceof AdminBootstrapFailure
        ? { kind: 'fdp-admin-bootstrap-failure/v1', stage: error.stage, codes: error.codes }
        : { kind: 'fdp-admin-bootstrap-failure/v1', stage: 'unknown', codes: [] };
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  });
}
