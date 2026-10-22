/** Temporary observer/cleanup only: application APIs perform every lifecycle write. */
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { readFileSync } from 'node:fs';
export function validateScope(s) {
  if (!/^csrprobe-[a-f0-9]{16}$/.test(s?.serial ?? '') || s.username !== s.serial + '@example.invalid')
    throw Error('INVALID_OWN_CSR_SCOPE');
  return s;
}
export async function execute(client, action, scope) {
  validateScope(scope);
  if (!['observe', 'cleanup', 'audit-empty'].includes(action)) throw Error('INVALID_ACTION');
  const q = (sql, args = []) => client.query(sql, args);
  const rows = async (sql, args = []) => (await q(sql, args)).rows;
  await q(
    action === 'cleanup' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  try {
    await q("SET LOCAL statement_timeout='15000ms'");
    await q("SET LOCAL lock_timeout='2000ms'");
    const devices = await rows(
      'SELECT id,serial_number,customer_id,site_id,lifecycle_status FROM devices WHERE serial_number=$1',
      [scope.serial],
    );
    if (devices.length > 1 || devices.some((d) => d.customer_id || d.site_id)) throw Error('OWN_DEVICE_SCOPE_DRIFT');
    const ids = devices.map((d) => d.id);
    const outside = async () =>
      rows(
        "SELECT 'devices' AS entity,count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM devices t WHERE NOT(id=ANY($1::text[])) UNION ALL SELECT 'certificates',count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM device_certificates t WHERE NOT(device_id=ANY($1::text[]))",
        [ids],
      );
    const before = await outside();
    const state = {
      devices,
      outsideFingerprints: before,
      certificates: await rows(
        'SELECT id,device_id,status,fingerprint,public_key_fingerprint,issuer,serial_number,mqtt_verified_at,rest_verified_at,claimed_at,rotated_from_id,rotation_deadline_at,rotation_confirmed_at,revoked_at,iot_deactivation_pending,iot_deactivation_attempts,iot_deactivated_at,package_ciphertext IS NULL AS package_destroyed FROM device_certificates WHERE device_id=ANY($1::text[]) ORDER BY created_at,id',
        [ids],
      ),
      requests: await rows(
        'SELECT id,serial_number,status,reviewed_by,reviewed_at,version,onboarding_deadline_at FROM onboarding_requests WHERE serial_number=$1',
        [scope.serial],
      ),
      jobs: await rows(
        'SELECT j.id,j.status,j.attempts,j.issued_certificate_id,j.completed_at FROM onboarding_provisioning_jobs j JOIN onboarding_requests r ON r.id=j.request_id WHERE r.serial_number=$1',
        [scope.serial],
      ),
      receipts: await rows(
        'SELECT device_id,topic_type,seq,payload_hash,result,processed_at FROM ingestion_receipts WHERE device_id=ANY($1::text[]) ORDER BY topic_type,seq',
        [ids],
      ),
      latest: await rows(
        'SELECT device_id,last_heartbeat_at,connectivity FROM device_latest_state WHERE device_id=ANY($1::text[])',
        [ids],
      ),
      history: await rows(
        'SELECT device_id,axis,from_status,to_status,actor_type,actor_id,reason,created_at FROM device_state_history WHERE device_id=ANY($1::text[]) ORDER BY created_at',
        [ids],
      ),
      publicKeys: await rows(
        'SELECT device_id,fingerprint FROM device_public_keys WHERE device_id=ANY($1::text[]) ORDER BY fingerprint',
        [ids],
      ),
      rotationRequests: await rows(
        'SELECT id,device_id,certificate_id,status FROM certificate_rotation_requests WHERE device_id=ANY($1::text[])',
        [ids],
      ),
      outbox: await rows(
        "SELECT id,event_type,status,aggregate_id FROM outbox_events WHERE aggregate_id=ANY($1::text[]) OR payload->>'deviceId'=ANY($1::text[]) OR aggregate_id IN(SELECT id FROM onboarding_requests WHERE serial_number=$2)",
        [ids, scope.serial],
      ),
      nonceCount: (
        await rows(
          'SELECT count(*)::int AS n FROM onboarding_proof_nonces WHERE request_id IN(SELECT id FROM onboarding_requests WHERE serial_number=$1)',
          [scope.serial],
        )
      )[0].n,
      users: await rows('SELECT id,email,status,cognito_sub FROM users WHERE email=$1', [scope.username]),
    };
    const auditIds = [...ids, ...state.certificates.map((c) => c.id), ...state.requests.map((r) => r.id)];
    state.audits = await rows(
      'SELECT id,actor_id,object_type,object_id,action,result,created_at FROM audit_logs WHERE object_id=ANY($1::text[]) ORDER BY created_at',
      [auditIds],
    );
    if (
      action === 'audit-empty' &&
      (devices.length || state.requests.length || state.users.some((u) => u.status !== 'DISABLED'))
    )
      throw Error('ACTIVE_OWN_ROWS_REMAIN');
    if (action === 'cleanup') {
      if (state.jobs.some((j) => ['PENDING', 'PROCESSING', 'RETRY'].includes(j.status)))
        throw Error('JOB_NOT_QUIESCENT');
      if (state.outbox.some((o) => !['PUBLISHED', 'FAILED'].includes(o.status))) throw Error('OUTBOX_NOT_QUIESCENT');
      const deleted = {};
      deleted.outbox = (
        await q(
          "DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[]) OR payload->>'deviceId'=ANY($1::text[]) OR aggregate_id IN(SELECT id FROM onboarding_requests WHERE serial_number=$2)",
          [ids, scope.serial],
        )
      ).rowCount;
      for (const table of [
        'certificate_rotation_requests',
        'device_user_sync_receipts',
        'ingestion_gaps',
        'ingestion_receipts',
        'device_latest_state',
        'device_state_history',
        'device_public_keys',
        'device_certificates',
      ])
        deleted[table] = (await q(`DELETE FROM public."${table}" WHERE device_id=ANY($1::text[])`, [ids])).rowCount;
      deleted.nonces = (
        await q(
          'DELETE FROM onboarding_proof_nonces WHERE request_id IN(SELECT id FROM onboarding_requests WHERE serial_number=$1)',
          [scope.serial],
        )
      ).rowCount;
      deleted.jobs = (
        await q(
          'DELETE FROM onboarding_provisioning_jobs WHERE request_id IN(SELECT id FROM onboarding_requests WHERE serial_number=$1)',
          [scope.serial],
        )
      ).rowCount;
      deleted.requests = (await q('DELETE FROM onboarding_requests WHERE serial_number=$1', [scope.serial])).rowCount;
      deleted.devices = (await q('DELETE FROM devices WHERE id=ANY($1::text[])', [ids])).rowCount;
      for (const u of state.users) {
        await q('DELETE FROM user_scopes WHERE user_id=$1', [u.id]);
        await q('DELETE FROM user_roles WHERE user_id=$1', [u.id]);
        await q("UPDATE users SET status='DISABLED',updated_at=now() WHERE id=$1 AND email=$2", [u.id, scope.username]);
      }
      if (JSON.stringify(before) !== JSON.stringify(await outside())) throw Error('OUTSIDE_DATA_CHANGED');
      state.deleted = deleted;
      await q('COMMIT');
    } else await q('ROLLBACK');
    return state;
  } catch (e) {
    await q('ROLLBACK');
    throw e;
  }
}
export async function handler(event) {
  const scope = validateScope(JSON.parse(process.env.CSR_SCOPE));
  let client;
  try {
    const sm = new SecretsManagerClient({ region: 'ap-southeast-1' });
    const secret = JSON.parse(
      (await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }))).SecretString,
    );
    if (secret.host !== 'fdp-test-db.c30ie84saulu.ap-southeast-1.rds.amazonaws.com' || secret.dbname !== 'fdp')
      throw Error('WRONG_DB');
    client = new pg.Client({
      host: secret.host,
      port: secret.port ?? 5432,
      user: secret.username,
      password: secret.password,
      database: secret.dbname,
      connectionTimeoutMillis: 10000,
      ssl: { ca: readFileSync('/var/task/rds-ca-bundle.pem', 'utf8'), rejectUnauthorized: true },
    });
    await client.connect();
    return { scope: scope.serial, result: await execute(client, event.action, scope) };
  } catch (e) {
    return {
      scope: scope.serial,
      error: { code: e.code ?? 'FIXTURE_ERROR', message: String(e.message).slice(0, 220) },
    };
  } finally {
    await client?.end().catch(() => {});
  }
}
