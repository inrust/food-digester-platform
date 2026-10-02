import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DB_TARGET } from './qa09-db-readonly-probe.mjs';
export const PROJECT = 'fdp-test-qa09-ten-device-fixtures';
export function assertOwnCloudDevice(id, prefix) {
  if (!/^qa09-[a-f0-9]{16}$/.test(prefix) || !new RegExp(`^${prefix}-(0[1-9]|10)$`).test(id))
    throw Error('NOT_OWN_DEVICE');
}
export function validatePlan(plan) {
  if (!/^qa09-[a-f0-9]{16}$/.test(plan.prefix ?? '') || !['seed', 'observe', 'cleanup'].includes(plan.action))
    throw Error('INVALID_FIXTURE_PLAN');
  const ids = Array.from({ length: 10 }, (_, i) => `${plan.prefix}-${String(i + 1).padStart(2, '0')}`);
  if (JSON.stringify(plan.devices) !== JSON.stringify(ids)) throw Error('EXACT_TEN_REQUIRED');
  if (
    !Array.isArray(plan.customers) ||
    plan.customers.length !== 2 ||
    plan.customers.some(
      (c) => !/^[a-f0-9-]{36}$/.test(c.id) || c.name !== `${plan.prefix}-${c.suffix}` || !['a', 'b'].includes(c.suffix),
    ) ||
    plan.customers[0].id === plan.customers[1].id
  )
    throw Error('OWN_CUSTOMERS_REQUIRED');
  return ids;
}
async function original(client, ids) {
  return (
    await client.query(
      "SELECT 'devices' AS entity,count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM devices t WHERE NOT(id=ANY($1::text[])) UNION ALL SELECT 'device_certificates',count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM device_certificates t WHERE NOT(device_id=ANY($1::text[]))",
      [ids],
    )
  ).rows;
}
export async function executeFixture(client, plan) {
  const ids = validatePlan(plan);
  let committed = false;
  try {
    await client.query(
      plan.action === 'observe'
        ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    );
    await client.query("SET LOCAL statement_timeout='10000ms'");
    await client.query("SET LOCAL lock_timeout='2000ms'");
    if ((await client.query('SELECT current_database() AS database')).rows[0].database !== 'fdp')
      throw Error('WRONG_DATABASE');
    const before = await original(client, ids);
    for (const c of plan.customers)
      if (
        (await client.query('SELECT id FROM customers WHERE id=$1 AND name=$2 AND deleted_at IS NULL', [c.id, c.name]))
          .rowCount !== 1
      )
        throw Error('CUSTOMER_SCOPE_DRIFT');
    if (plan.action === 'seed') {
      if (
        (await client.query('SELECT id FROM devices WHERE id=ANY($1::text[]) OR serial_number=ANY($1::text[])', [ids]))
          .rowCount
      )
        throw Error('FIXTURES_ALREADY_EXIST');
      for (const [i, id] of ids.entries())
        await client.query(
          "INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,lifecycle_status,customer_id,updated_at) VALUES($1,$1,'BNX-100','1','Bio-Nexa','2026-01-01','PendingOnboarding',$2,now())",
          [id, plan.customers[i < 5 ? 0 : 1].id],
        );
    }
    const devices = (
      await client.query(
        'SELECT id,serial_number,customer_id,lifecycle_status FROM devices WHERE id=ANY($1::text[]) ORDER BY id',
        [ids],
      )
    ).rows;
    if (plan.action !== 'observe' && devices.length !== 10) throw Error('FIXTURE_SET_INCOMPLETE');
    if (
      devices.some(
        (d, i) => d.id !== ids[i] || d.serial_number !== d.id || d.customer_id !== plan.customers[i < 5 ? 0 : 1].id,
      )
    )
      throw Error('DEVICE_SCOPE_DRIFT');
    const certificates = (
      await client.query(
        'SELECT id,device_id,status,fingerprint,mqtt_verified_at,rest_verified_at,claimed_at,package_ciphertext IS NULL AS package_destroyed FROM device_certificates WHERE device_id=ANY($1::text[]) ORDER BY device_id,id',
        [ids],
      )
    ).rows;
    const requests = (
      await client.query(
        'SELECT id,serial_number,status FROM onboarding_requests WHERE serial_number=ANY($1::text[]) ORDER BY serial_number',
        [ids],
      )
    ).rows;
    const jobs = (
      await client.query(
        'SELECT j.id,j.status,j.attempts,j.issued_certificate_id FROM onboarding_provisioning_jobs j JOIN onboarding_requests r ON r.id=j.request_id WHERE r.serial_number=ANY($1::text[]) ORDER BY r.serial_number',
        [ids],
      )
    ).rows;
    const receipts = (
      await client.query(
        'SELECT id,device_id,topic_type,seq,payload_hash,result,occurred_at,processed_at FROM ingestion_receipts WHERE device_id=ANY($1::text[]) ORDER BY device_id,topic_type,seq',
        [ids],
      )
    ).rows;
    const latest = (
      await client.query(
        'SELECT device_id,last_heartbeat_at FROM device_latest_state WHERE device_id=ANY($1::text[]) ORDER BY device_id',
        [ids],
      )
    ).rows;
    const telemetrySamples = (
      await client.query(
        'SELECT device_id,sum(sample_count)::text AS samples FROM telemetry_hourly WHERE device_id=ANY($1::text[]) GROUP BY device_id ORDER BY device_id',
        [ids],
      )
    ).rows;
    const outbox = (
      await client.query(
        "SELECT id,event_type,aggregate_id,status,payload FROM outbox_events WHERE aggregate_id=ANY($1::text[]) OR payload->>'deviceId'=ANY($1::text[]) ORDER BY id",
        [ids],
      )
    ).rows.map(({ payload, ...r }) => ({
      ...r,
      rawBodySha256:
        typeof payload.rawBody === 'string' ? createHash('sha256').update(payload.rawBody).digest('hex') : null,
      messageId: payload.messageId ?? null,
      topicType: payload.topicType ?? null,
      customerId: payload.customerId ?? null,
      payloadHash: payload.payloadHash ?? null,
    }));
    const deleted = {};
    if (plan.action === 'cleanup') {
      await client.query('LOCK TABLE onboarding_requests,onboarding_provisioning_jobs IN SHARE ROW EXCLUSIVE MODE');
      if (
        (
          await client.query(
            "SELECT j.id FROM onboarding_provisioning_jobs j JOIN onboarding_requests r ON r.id=j.request_id WHERE r.serial_number=ANY($1::text[]) AND j.status='PROCESSING'",
            [ids],
          )
        ).rowCount
      )
        throw Error('JOB_STILL_PROCESSING');
      await client.query(
        'DELETE FROM onboarding_proof_nonces WHERE request_id IN(SELECT id FROM onboarding_requests WHERE serial_number=ANY($1::text[]))',
        [ids],
      );
      await client.query(
        'DELETE FROM onboarding_provisioning_jobs WHERE request_id IN(SELECT id FROM onboarding_requests WHERE serial_number=ANY($1::text[]))',
        [ids],
      );
      await client.query('DELETE FROM onboarding_requests WHERE serial_number=ANY($1::text[])', [ids]);
      for (const table of [
        'ingestion_gaps',
        'ingestion_receipts',
        'telemetry_hourly',
        'telemetry_daily',
        'device_events',
        'tamper_events',
        'alarms',
        'device_latest_state',
        'device_state_history',
        'device_public_keys',
        'device_certificates',
      ])
        deleted[table] = (
          await client.query(`DELETE FROM public."${table}" WHERE device_id=ANY($1::text[])`, [ids])
        ).rowCount;
      deleted.outbox_events = (
        await client.query(
          "DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[]) OR payload->>'deviceId'=ANY($1::text[])",
          [ids],
        )
      ).rowCount;
      deleted.devices = (await client.query('DELETE FROM devices WHERE id=ANY($1::text[])', [ids])).rowCount;
      if (deleted.devices !== 10) throw Error('DELETE_COUNT_MISMATCH');
    }
    const after = await original(client, ids);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('ORIGINAL_DEVICE_OR_CERTIFICATE_CHANGED');
    if (plan.baseline && JSON.stringify(after) !== JSON.stringify(plan.baseline))
      throw Error('ORIGINAL_BASELINE_DRIFT');
    if (plan.action === 'observe') await client.query('ROLLBACK');
    else await client.query('COMMIT');
    committed = true;
    return {
      devices,
      certificates,
      requests,
      jobs,
      receipts,
      latest,
      outbox,
      telemetrySamples,
      deleted,
      originalFingerprints: after,
    };
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}
function aws(args) {
  const r = spawnSync('aws', [...args, '--region', DB_TARGET.region, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.status !== 0) throw Error('AWS_READ_FAILED');
  return JSON.parse(r.stdout);
}
async function main() {
  const id = aws(['sts', 'get-caller-identity']);
  if (
    id.Account !== DB_TARGET.accountId ||
    !id.Arn.includes(':assumed-role/fdp-test-migration-runner-role/') ||
    !process.env.CODEBUILD_BUILD_ID?.startsWith(PROJECT + ':')
  )
    throw Error('WRONG_RUNNER');
  if (
    createHash('sha256')
      .update(readFileSync(new URL(import.meta.url)))
      .digest('hex') !== process.env.QA09_FIXTURE_HASH
  )
    throw Error('SOURCE_HASH_MISMATCH');
  const plan = JSON.parse(Buffer.from(process.env.QA09_FIXTURE_PLAN_B64, 'base64'));
  validatePlan(plan);
  const secret = JSON.parse(
    aws(['secretsmanager', 'get-secret-value', '--secret-id', DB_TARGET.secretArn]).SecretString,
  );
  if (secret.host !== DB_TARGET.host || secret.dbname !== 'fdp') throw Error('WRONG_DATABASE');
  const { Client } = createRequire(resolve('package.json'))('pg');
  const client = new Client({
    host: secret.host,
    port: 5432,
    user: secret.username,
    password: secret.password,
    database: 'fdp',
    connectionTimeoutMillis: 10000,
    ssl: { ca: readFileSync('rds-ca-bundle.pem', 'utf8'), rejectUnauthorized: true },
  });
  try {
    await client.connect();
    const result = await executeFixture(client, plan);
    console.log(
      JSON.stringify({
        kind: 'fdp-qa09-ten-device-db/v1',
        gate: 'PASS',
        action: plan.action,
        prefix: plan.prefix,
        sourceHash: process.env.QA09_FIXTURE_HASH,
        buildId: process.env.CODEBUILD_BUILD_ID,
        ...result,
      }),
    );
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error('QA09_FIXTURE_OPERATION_FAILED');
    process.exitCode = 1;
  });
