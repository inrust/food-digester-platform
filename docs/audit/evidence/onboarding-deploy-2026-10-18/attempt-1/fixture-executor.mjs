import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const PROJECT = 'fdp-test-onboarding-fixtures-20261018';
export function validatePlan(p) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    !/^qa09-[a-f0-9]{16}$/.test(p.prefix ?? '') ||
    p.serialNumber !== `${p.prefix}-onboarding` ||
    !['observe', 'cleanup'].includes(p.action) ||
    !/^[a-f0-9]{40}$/.test(p.applicationCommit ?? '')
  )
    throw Error('INVALID_PLAN');
  if (
    p.action === 'cleanup' &&
    (!uuid.test(p.requestId ?? '') ||
      !uuid.test(p.deviceId ?? '') ||
      p.cloudCleanupVerified !== true ||
      !Array.isArray(p.certificateIds) ||
      p.certificateIds.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(p.certificateIds[0]))
  )
    throw Error('EXACT_OWN_LEDGER_REQUIRED');
}
async function outside(client, p) {
  const result = {};
  for (const [table, column, value] of [
    ['devices', 'serial_number', p.serialNumber],
    ['onboarding_requests', 'serial_number', p.serialNumber],
    ['onboarding_provisioning_jobs', 'request_id', p.requestId],
    ['onboarding_proof_nonces', 'request_id', p.requestId],
    ['device_public_keys', 'device_id', p.deviceId],
    ['device_state_history', 'device_id', p.deviceId],
    ['device_certificates', 'device_id', p.deviceId],
  ])
    result[table] = (
      await client.query(
        `SELECT count(*)::text AS count, md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM public."${table}" t WHERE $1::text IS NULL OR "${column}" <> $1`,
        [value ?? null],
      )
    ).rows[0];
  return result;
}
export async function execute(client, p) {
  validatePlan(p);
  let committed = false;
  try {
    await client.query(
      p.action === 'cleanup'
        ? 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE'
        : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    await client.query("SET LOCAL statement_timeout='10000ms'");
    await client.query("SET LOCAL lock_timeout='2000ms'");
    const identity = (
      await client.query("SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only")
    ).rows[0];
    if (identity.database !== 'fdp' || (p.action === 'observe' && identity.read_only !== 'on'))
      throw Error('WRONG_DATABASE');
    if (p.action === 'cleanup')
      await client.query('LOCK TABLE onboarding_requests,onboarding_provisioning_jobs IN SHARE ROW EXCLUSIVE MODE');
    const requests = (
      await client.query(
        'SELECT id,serial_number,status,version,reviewed_by,reviewed_at FROM onboarding_requests WHERE serial_number=$1 ORDER BY id',
        [p.serialNumber],
      )
    ).rows;
    const devices = (
      await client.query('SELECT id,serial_number,lifecycle_status,customer_id FROM devices WHERE serial_number=$1', [
        p.serialNumber,
      ])
    ).rows;
    const requestId = requests[0]?.id,
      deviceId = devices[0]?.id;
    const jobs = (
      await client.query(
        'SELECT id,request_id,status,issued_certificate_id FROM onboarding_provisioning_jobs WHERE request_id=$1',
        [requestId ?? null],
      )
    ).rows;
    const certificates = (
      await client.query(
        'SELECT id,device_id,fingerprint,status,claimed_at FROM device_certificates WHERE device_id=$1',
        [deviceId ?? null],
      )
    ).rows;
    const audit = (
      await client.query(
        "SELECT object_id,action,result,actor_id FROM audit_logs WHERE object_type='onboarding_request' AND object_id=$1 ORDER BY created_at",
        [p.requestId ?? requestId ?? null],
      )
    ).rows;
    const before = await outside(client, p);
    const deleted = {};
    if (p.action === 'cleanup') {
      if (
        requests.length !== 1 ||
        devices.length !== 1 ||
        requestId !== p.requestId ||
        deviceId !== p.deviceId ||
        devices[0].customer_id !== null
      )
        throw Error('OWNERSHIP_DRIFT');
      if (jobs.length !== 1 || jobs[0].status !== 'COMPLETED' || requests[0].status !== 'APPROVED')
        throw Error('JOB_NOT_COMPLETED');
      if (JSON.stringify(certificates.map((c) => c.id).sort()) !== JSON.stringify([...p.certificateIds].sort()))
        throw Error('CERTIFICATE_LEDGER_DRIFT');
      for (const [table, column, value] of [
        ['onboarding_proof_nonces', 'request_id', p.requestId],
        ['onboarding_provisioning_jobs', 'request_id', p.requestId],
        ['onboarding_requests', 'id', p.requestId],
        ['device_state_history', 'device_id', p.deviceId],
        ['device_public_keys', 'device_id', p.deviceId],
        ['device_certificates', 'device_id', p.deviceId],
        ['devices', 'id', p.deviceId],
      ])
        deleted[table] = (await client.query(`DELETE FROM public."${table}" WHERE "${column}"=$1`, [value])).rowCount;
      if (JSON.stringify(before) !== JSON.stringify(await outside(client, p))) throw Error('OUTSIDE_ROWS_CHANGED');
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    committed = true;
    return {
      identity,
      requests,
      devices,
      jobs,
      certificates,
      audit,
      outsideFingerprints: before,
      deleted,
      auditPreserved: true,
    };
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
  }
}
function aws(args) {
  const r = spawnSync('aws', [...args, '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.status !== 0) throw Error('AWS_OPERATION_FAILED');
  return JSON.parse(r.stdout);
}
async function main() {
  const hash = createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex');
  if (hash !== process.env.ONBOARDING_FIXTURE_SHA256 || !process.env.CODEBUILD_BUILD_ID?.startsWith(PROJECT + ':'))
    throw Error('SOURCE_OR_PROJECT_DRIFT');
  const identity = aws(['sts', 'get-caller-identity']);
  if (
    identity.Account !== '065986019555' ||
    !identity.Arn.startsWith('arn:aws:sts::065986019555:assumed-role/fdp-test-migration-runner-role/')
  )
    throw Error('WRONG_ACCOUNT');
  const p = JSON.parse(Buffer.from(process.env.ONBOARDING_FIXTURE_PLAN_B64 ?? '', 'base64').toString());
  validatePlan(p);
  const secret = JSON.parse(
    aws([
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-rds-credentials-hBessK',
    ]).SecretString,
  );
  if (
    secret.host !== 'fdp-test-db.c30ie84saulu.ap-southeast-1.rds.amazonaws.com' ||
    secret.dbname !== 'fdp' ||
    (secret.port ?? 5432) !== 5432
  )
    throw Error('WRONG_SECRET_TARGET');
  const { Client } = createRequire(resolve('package.json'))('pg');
  const c = new Client({
    host: secret.host,
    port: 5432,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl: { ca: readFileSync('rds-ca-bundle.pem', 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
  });
  try {
    await c.connect();
    const result = await execute(c, p);
    console.log(
      JSON.stringify({
        kind: 'onboarding-rollout-fixture/v1',
        gate: 'PASS',
        sourceHash: hash,
        buildId: process.env.CODEBUILD_BUILD_ID,
        plan: p,
        ...result,
      }),
    );
  } finally {
    await c.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((e) => {
    console.error(
      JSON.stringify({
        kind: 'onboarding-rollout-fixture-failure/v1',
        code: /^[A-Z0-9_]{1,80}$/.test(e.message ?? '') ? e.message : 'REDACTED_FAILURE',
      }),
    );
    process.exitCode = 1;
  });
