/** Fixed own scope observer/cleanup; all business setup is performed through real APIs. */
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
export function validateScope(s) {
  if (
    !/^syncprobe-[a-f0-9]{16}$/.test(s?.serial ?? '') ||
    s.username !== s.serial + '@example.invalid' ||
    s.model !== 'SYNC-' + s.serial.slice(10).toUpperCase() ||
    JSON.stringify(s.names) !== JSON.stringify([s.serial + '-a', s.serial + '-b'])
  )
    throw Error('INVALID_OWN_SYNC_SCOPE');
  return s;
}
export async function execute(client, action, scope) {
  validateScope(scope);
  if (!['observe', 'cleanup', 'audit-empty', 'close-parents', 'legacy-active'].includes(action))
    throw Error('INVALID_ACTION');
  const q = (sql, args = []) => client.query(sql, args);
  const rows = async (sql, args = []) => (await q(sql, args)).rows;
  await q(
    ['cleanup', 'close-parents', 'legacy-active'].includes(action)
      ? 'BEGIN ISOLATION LEVEL SERIALIZABLE'
      : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  try {
    await q("SET LOCAL statement_timeout='15000ms'");
    await q("SET LOCAL lock_timeout='2000ms'");
    const devices = await rows(
      'SELECT id,serial_number,model,alias,firmware_version,customer_id,site_id,lifecycle_status FROM devices WHERE serial_number=$1',
      [scope.serial],
    );
    const customers = await rows(
      'SELECT id,name,status,version,deleted_at FROM customers WHERE name=ANY($1::text[]) ORDER BY name',
      [scope.names],
    );
    const cids = customers.map((c) => c.id);
    const sites = await rows(
      'SELECT id,customer_id,name,region,subregion,status,version,deleted_at FROM sites WHERE customer_id=ANY($1::text[]) ORDER BY name',
      [cids],
    );
    if (customers.length > 2 || sites.some((s) => !scope.names.some((n) => s.name === n + '-site')))
      throw Error('OWN_PARENT_SCOPE_DRIFT');
    if (
      devices.length > 1 ||
      devices.some(
        (d) =>
          d.model !== scope.model ||
          (d.customer_id && d.customer_id !== customers.find((c) => c.name === scope.names[0])?.id) ||
          (d.site_id && !sites.some((s) => s.id === d.site_id && s.customer_id === d.customer_id)),
      )
    )
      throw Error('OWN_DEVICE_SCOPE_DRIFT');
    const ids = devices.map((d) => d.id);
    const outside = async () =>
      rows(
        "SELECT 'devices' AS entity,count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM devices t WHERE NOT(id=ANY($1::text[])) UNION ALL SELECT 'certificates',count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM device_certificates t WHERE NOT(device_id=ANY($1::text[]))",
        [ids],
      );
    const licenses = await rows(
      'SELECT id,device_id,customer_id,status,version,valid_from,valid_to,signature FROM licenses WHERE customer_id=ANY($1::text[]) OR device_id=ANY($2::text[]) ORDER BY created_at',
      [cids, ids],
    );
    if (licenses.some((l) => !ids.includes(l.device_id) || !cids.includes(l.customer_id)))
      throw Error('OWN_LICENSE_SCOPE_DRIFT');
    const lids = licenses.map((l) => l.id);
    const configurations = await rows(
      'SELECT id,name,target_device_id,target_model FROM device_configurations WHERE target_device_id=ANY($1::text[]) OR target_model=$2 ORDER BY name',
      [ids, scope.model],
    );
    if (configurations.some((c) => !c.name.startsWith(scope.serial + '-')))
      throw Error('OWN_CONFIGURATION_SCOPE_DRIFT');
    const cfgids = configurations.map((c) => c.id);
    const userRows = await rows(
      'SELECT id,customer_id,username,display_name,status,version,password_hash FROM device_users WHERE customer_id=ANY($1::text[]) ORDER BY username',
      [cids],
    );
    if (userRows.some((u) => !u.username.startsWith(scope.serial + '-'))) throw Error('OWN_USER_SCOPE_DRIFT');
    const uids = userRows.map((u) => u.id);
    const deviceUsers = userRows.map(({ password_hash, ...u }) => ({
      ...u,
      password_hash_sha256: password_hash ? createHash('sha256').update(password_hash).digest('hex') : null,
      argon2id: typeof password_hash === 'string' && password_hash.startsWith('$argon2id$v=19$m=32768,t=3,p=1$'),
    }));
    const versions = await rows(
      'SELECT id,configuration_id,version,payload,status,effective_at FROM configuration_versions WHERE configuration_id=ANY($1::text[]) ORDER BY configuration_id,version',
      [cfgids],
    );
    const scopes = [
      ['customers', 'name=ANY($1::text[])', scope.names],
      ['sites', 'customer_id=ANY($1::text[])', cids],
      ['device_assignments', 'device_id=ANY($1::text[])', ids],
      ['licenses', 'device_id=ANY($1::text[])', ids],
      ['license_history', 'license_id=ANY($1::text[])', lids],
      ['license_entitlements', 'license_id=ANY($1::text[])', lids],
      ['device_configurations', 'id=ANY($1::text[])', cfgids],
      ['configuration_versions', 'configuration_id=ANY($1::text[])', cfgids],
      ['device_users', 'customer_id=ANY($1::text[])', cids],
      ['device_user_assignments', 'device_user_id=ANY($1::text[])', uids],
      ['device_user_sync_receipts', 'device_id=ANY($1::text[])', ids],
    ];
    const businessOutside = async () =>
      Promise.all(
        scopes.map(async ([table, predicate, values]) => ({
          entity: table,
          ...(
            await rows(
              `SELECT count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM public."${table}" t WHERE NOT COALESCE((${predicate}),false)`,
              [values],
            )
          )[0],
        })),
      );
    const before = await outside();
    const outsideBusinessFingerprints = await businessOutside();
    const outboxIds = [
      ...ids,
      ...lids,
      ...cfgids,
      ...versions.map((v) => v.id),
      ...uids,
      ...cids,
      ...sites.map((s) => s.id),
    ];
    const state = {
      devices,
      customers,
      sites,
      licenses,
      configurations,
      versions,
      deviceUsers,
      outsideBusinessFingerprints,
      outsideFingerprints: before,
      assignments: await rows(
        'SELECT id,device_id,customer_id,site_id,status,assigned_at,ended_at FROM device_assignments WHERE device_id=ANY($1::text[]) ORDER BY assigned_at',
        [ids],
      ),
      entitlements: await rows(
        'SELECT license_id,code,enabled FROM license_entitlements WHERE license_id=ANY($1::text[]) ORDER BY code',
        [lids],
      ),
      licenseHistory: await rows(
        'SELECT license_id,from_status,to_status,created_at FROM license_history WHERE license_id=ANY($1::text[]) ORDER BY created_at',
        [lids],
      ),
      userAssignments: await rows(
        'SELECT device_user_id,device_id,customer_id,status,assigned_at,revoked_at FROM device_user_assignments WHERE device_user_id=ANY($1::text[]) ORDER BY assigned_at',
        [uids],
      ),
      syncReceipts: await rows(
        'SELECT device_id,device_user_id,entity_version,served_at,device_reported_last_sync_at,acknowledged_at FROM device_user_sync_receipts WHERE device_id=ANY($1::text[]) ORDER BY device_user_id,entity_version',
        [ids],
      ),
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
        'SELECT device_id,customer_id,last_heartbeat_at,connectivity,operational_status FROM device_latest_state WHERE device_id=ANY($1::text[])',
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
        "SELECT id,event_type,status,aggregate_type,aggregate_id,published_at,payload->>'deviceId' AS device_id,payload->>'customerId' AS customer_id,payload->>'entityVersion' AS entity_version,payload->>'archiveClass' AS archive_class,payload->>'topic' AS topic FROM outbox_events WHERE aggregate_id=ANY($1::text[]) OR payload->>'deviceId'=ANY($2::text[]) OR payload->>'customerId'=ANY($3::text[]) OR aggregate_id IN(SELECT id FROM onboarding_requests WHERE serial_number=$4) ORDER BY created_at,id",
        [outboxIds, ids, cids, scope.serial],
      ),
      nonceCount: (
        await rows(
          'SELECT count(*)::int AS n FROM onboarding_proof_nonces WHERE request_id IN(SELECT id FROM onboarding_requests WHERE serial_number=$1)',
          [scope.serial],
        )
      )[0].n,
      users: await rows('SELECT id,email,status,cognito_sub FROM users WHERE email=$1', [scope.username]),
    };
    if (state.userAssignments.some((a) => !ids.includes(a.device_id) || !cids.includes(a.customer_id)))
      throw Error('OWN_USER_GRANT_SCOPE_DRIFT');
    const auditIds = [...outboxIds, ...state.certificates.map((c) => c.id), ...state.requests.map((r) => r.id)];
    state.audits = await rows(
      "SELECT id,actor_id,object_type,object_id,action,result,request_id,created_at,after_value->>'snapshotEtag' AS snapshot_etag,after_value->>'licenseId' AS license_id,after_value->>'confirmation' AS confirmation,after_value->>'lifecycleStatus' AS lifecycle_status FROM audit_logs WHERE object_id=ANY($1::text[]) ORDER BY created_at",
      [auditIds],
    );
    if (
      action === 'audit-empty' &&
      (devices.length ||
        state.requests.length ||
        licenses.length ||
        configurations.length ||
        deviceUsers.length ||
        customers.some((c) => !c.deleted_at) ||
        sites.some((s) => !s.deleted_at) ||
        state.users.some((u) => u.status !== 'DISABLED'))
    )
      throw Error('ACTIVE_OWN_ROWS_REMAIN');
    if (action === 'legacy-active') {
      if (devices.length !== 1 || state.latest.length !== 1 || state.latest[0].operational_status !== 'Active')
        throw Error('OWN_CANONICAL_STATE_REQUIRED');
      const changed = await rows(
        "UPDATE device_latest_state SET operational_status='ACTIVE' WHERE device_id=$1 AND operational_status='Active' RETURNING device_id,operational_status",
        [devices[0].id],
      );
      if (changed.length !== 1) throw Error('OWN_LEGACY_UPDATE_RACE');
      if (JSON.stringify(before) !== JSON.stringify(await outside())) throw Error('OUTSIDE_DATA_CHANGED');
      if (JSON.stringify(outsideBusinessFingerprints) !== JSON.stringify(await businessOutside()))
        throw Error('OUTSIDE_BUSINESS_DATA_CHANGED');
      state.legacyUpdate = changed[0];
      await q('COMMIT');
      return state;
    } else if (action === 'close-parents') {
      if (
        devices.length ||
        licenses.length ||
        configurations.length ||
        deviceUsers.length ||
        state.requests.length ||
        (await rows('SELECT id FROM devices WHERE customer_id=ANY($1::text[])', [cids])).length
      )
        throw Error('OWN_CHILDREN_REMAIN');
      let closed = 0;
      for (const [table, objectType, items] of [
        ['sites', 'site', sites],
        ['customers', 'customer', customers],
      ])
        for (const item of items) {
          if (item.deleted_at) continue;
          await q(
            `UPDATE public."${table}" SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND deleted_at IS NULL`,
            [item.id],
          );
          await q(
            "INSERT INTO audit_logs(id,actor_id,actor_role,customer_id,object_type,object_id,action,result,after_value) VALUES($1,'system:isolated-sync-cleanup','SYSTEM',$2,$3,$4,'test.resource.cleanup','SUCCESS',$5::jsonb)",
            [
              randomUUID(),
              objectType === 'customer' ? item.id : item.customer_id,
              objectType,
              item.id,
              JSON.stringify({ softDeleted: true, serial: scope.serial }),
            ],
          );
          closed++;
        }
      if (
        JSON.stringify(before) !== JSON.stringify(await outside()) ||
        JSON.stringify(outsideBusinessFingerprints) !== JSON.stringify(await businessOutside())
      )
        throw Error('OUTSIDE_DATA_CHANGED');
      await q('COMMIT');
      return { ...state, parentsClosed: closed };
    }
    if (action === 'cleanup') {
      if (state.jobs.some((j) => ['PENDING', 'PROCESSING', 'RETRY'].includes(j.status)))
        throw Error('JOB_NOT_QUIESCENT');
      if (state.outbox.some((o) => !['PUBLISHED', 'FAILED'].includes(o.status))) throw Error('OUTBOX_NOT_QUIESCENT');
      const deleted = {};
      deleted.outbox = (
        await q('DELETE FROM outbox_events WHERE id=ANY($1::text[])', [state.outbox.map((o) => o.id)])
      ).rowCount;
      for (const [table, predicate, values] of [
        ['device_user_sync_receipts', 'device_id=ANY($1::text[])', ids],
        ['device_user_assignments', 'device_user_id=ANY($1::text[])', uids],
        ['device_users', 'id=ANY($1::text[])', uids],
        ['configuration_versions', 'configuration_id=ANY($1::text[])', cfgids],
        ['device_configurations', 'id=ANY($1::text[])', cfgids],
        ['license_history', 'license_id=ANY($1::text[])', lids],
        ['license_entitlements', 'license_id=ANY($1::text[])', lids],
        ['licenses', 'id=ANY($1::text[])', lids],
        ['device_assignments', 'device_id=ANY($1::text[])', ids],
      ])
        deleted[table] = (await q(`DELETE FROM public."${table}" WHERE ${predicate}`, [values])).rowCount;
      for (const table of [
        'certificate_rotation_requests',
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
      if (JSON.stringify(outsideBusinessFingerprints) !== JSON.stringify(await businessOutside()))
        throw Error('OUTSIDE_BUSINESS_DATA_CHANGED');
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
  const scope = validateScope(JSON.parse(process.env.REST_SYNC_SCOPE));
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
