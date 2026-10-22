/** Owned one-device SQL fixture for the MQTT smoke; deploy only as a temporary VPC Lambda. */
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const sm = new SecretsManagerClient({ region: 'ap-southeast-1' });
export function validateScope(s) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    !/^mqttbiz-[a-f0-9]{16}$/.test(s?.deviceId ?? '') ||
    ![
      'customerId',
      'siteId',
      'licenseId',
      'packageId',
      'campaignId',
      'targetId',
      'mediaSessionId',
      'notificationId',
    ].every((k) => uuid.test(s[k] ?? '')) ||
    s.commandId !== `CMD-${s.deviceId.toUpperCase()}-1` ||
    s.mediaKey !== `media/${s.customerId}/${s.deviceId}/${s.mediaSessionId}/probe.png` ||
    !/^[a-f0-9]{64}$/.test(s.mediaHash ?? '') ||
    !/^[a-f0-9]{64}$/.test(s.packageHash ?? '') ||
    !s.packageKey?.startsWith(`mqtt-business/${s.deviceId}/`)
  )
    throw Error('INVALID_OWN_SCOPE');
  return s;
}
export async function execute(client, action, s, certificate) {
  validateScope(s);
  const ids = [
    s.deviceId,
    s.commandId,
    s.targetId,
    s.campaignId,
    s.packageId,
    s.mediaSessionId,
    s.licenseId,
    s.customerId,
    s.siteId,
  ];
  const q = (sql, args = []) => client.query(sql, args);
  const rows = async (sql, args = []) => (await q(sql, args)).rows;
  const snapshot = async () => ({
    devices: await rows('SELECT id,customer_id,site_id,lifecycle_status FROM devices WHERE id=$1', [s.deviceId]),
    certificates: await rows('SELECT id,status FROM device_certificates WHERE device_id=$1', [s.deviceId]),
    latest: await rows(
      'SELECT device_id,connectivity,machine_mode,last_heartbeat_at FROM device_latest_state WHERE device_id=$1',
      [s.deviceId],
    ),
    receipts: await rows(
      'SELECT device_id,customer_id,site_id,topic_type,seq,payload_hash,result,occurred_at,processed_at FROM ingestion_receipts WHERE device_id=$1 ORDER BY topic_type,seq',
      [s.deviceId],
    ),
    telemetry: await rows('SELECT * FROM telemetry_hourly WHERE device_id=$1', [s.deviceId]),
    reports: await rows(
      'SELECT source_message_id,report_type,feeding_weight_kg,period_start_time,period_end_time FROM esg_reports WHERE device_id=$1',
      [s.deviceId],
    ),
    alarms: await rows('SELECT code,status,source_message_id FROM alarms WHERE device_id=$1', [s.deviceId]),
    events: await rows('SELECT event_type,source_message_id FROM device_events WHERE device_id=$1', [s.deviceId]),
    tampers: await rows('SELECT event_type,severity,source_message_id FROM tamper_events WHERE device_id=$1', [
      s.deviceId,
    ]),
    commands: await rows('SELECT id,status,command,device_id FROM device_commands WHERE id=$1', [s.commandId]),
    attempts: await rows(
      'SELECT command_id,attempt_no,outcome,provider_message_id FROM command_attempts WHERE command_id=$1',
      [s.commandId],
    ),
    acks: await rows('SELECT command_id,result,source_message_id FROM command_acks WHERE command_id=$1', [s.commandId]),
    targets: await rows('SELECT id,device_id,status,dispatch_attempt_count FROM ota_targets WHERE id=$1', [s.targetId]),
    otaHistory: await rows(
      'SELECT from_status,to_status FROM ota_status_history WHERE target_id=$1 ORDER BY created_at',
      [s.targetId],
    ),
    media: await rows(
      'SELECT device_id,upload_session_id,status,sha256,object_path,source_message_id FROM media_objects WHERE device_id=$1',
      [s.deviceId],
    ),
    mediaSessions: await rows('SELECT id,status FROM media_upload_sessions WHERE device_id=$1', [s.deviceId]),
    outbox: await rows(
      "SELECT id,event_type,aggregate_type,aggregate_id,status,published_at,payload->>'topicType' AS topic_type FROM outbox_events WHERE aggregate_id=ANY($1::text[]) OR payload->>'deviceId'=$2 ORDER BY created_at",
      [ids, s.deviceId],
    ),
    audits: await rows(
      'SELECT object_type,object_id,action,result FROM audit_logs WHERE customer_id=$1 OR actor_id=$2 OR object_id=ANY($3::text[]) ORDER BY created_at',
      [s.customerId, s.deviceId, ids],
    ),
  });
  if (action === 'preflight')
    return {
      database: (await rows('SELECT current_database() AS name'))[0],
      ownDeviceCount: (await rows('SELECT count(*)::int AS n FROM devices WHERE id=$1', [s.deviceId]))[0].n,
    };
  if (['observe', 'audit-empty'].includes(action)) {
    await q('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const state = await snapshot();
      state.auditCustomerTombstone = await rows('SELECT id,name,status,deleted_at FROM customers WHERE id=$1', [
        s.customerId,
      ]);
      state.fixtureCounts = {};
      for (const [table, col, id] of [
        ['customers', 'id', s.customerId],
        ['sites', 'id', s.siteId],
        ['licenses', 'id', s.licenseId],
        ['firmware_packages', 'id', s.packageId],
        ['ota_campaigns', 'id', s.campaignId],
      ])
        state.fixtureCounts[table] = (await rows(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]))[0].n;
      return state;
    } finally {
      await q('ROLLBACK');
    }
  }
  await q('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await q("SET LOCAL statement_timeout='15000ms'");
    await q("SET LOCAL lock_timeout='2000ms'");
    if (action === 'seed') {
      if (!/^[a-f0-9]{64}$/.test(certificate?.id ?? '') || !/^[a-f0-9]{64}$/.test(certificate?.fingerprint ?? ''))
        throw Error('INVALID_CERTIFICATE');
      await q("INSERT INTO customers(id,name,status,version,updated_at) VALUES($1,$2,'ACTIVE',1,now())", [
        s.customerId,
        s.deviceId,
      ]);
      await q(
        "INSERT INTO sites(id,customer_id,name,status,version,timezone,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'Asia/Shanghai',now())",
        [s.siteId, s.customerId, s.deviceId],
      );
      await q(
        "INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,customer_id,site_id,lifecycle_status,firmware_version,updated_at) VALUES($1,$1,$2,'TEST','MQTT-ISOLATED-PROBE',current_date,$3,$4,'Active','0.0.0-test',now())",
        [s.deviceId, s.deviceId, s.customerId, s.siteId],
      );
      await q(
        "INSERT INTO device_assignments(id,device_id,customer_id,site_id,assigned_at,assigned_by) VALUES($1,$2,$3,$4,now()-interval '1 minute',$2)",
        [randomUUID(), s.deviceId, s.customerId, s.siteId],
      );
      await q(
        "INSERT INTO device_certificates(id,device_id,fingerprint,status,certificate_arn,not_before,not_after) VALUES($1,$2,$3,'ACTIVE',$4,$5,$6)",
        [
          certificate.id,
          s.deviceId,
          certificate.fingerprint,
          certificate.arn,
          certificate.notBefore,
          certificate.notAfter,
        ],
      );
      await q(
        "INSERT INTO licenses(id,device_id,customer_id,status,valid_from,valid_to,created_by,updated_at) VALUES($1,$2,$3,'Active',now()-interval '1 hour',now()+interval '1 day',$2,now())",
        [s.licenseId, s.deviceId, s.customerId],
      );
      for (const code of ['OTA_UPDATE', 'REMOTE_CONTROL', 'ESG_REPORTING'])
        await q('INSERT INTO license_entitlements(id,license_id,code,enabled) VALUES($1,$2,$3,true)', [
          randomUUID(),
          s.licenseId,
          code,
        ]);
      await q(
        "INSERT INTO media_upload_sessions(id,device_id,customer_id,media_type,file_name,size_kb,declared_sha256,presigned_url_expires_at) VALUES($1,$2,$3,'IMAGE','probe.png',1,$4,now()+interval '20 minutes')",
        [s.mediaSessionId, s.deviceId, s.customerId, s.mediaHash],
      );
    } else {
      const owned = await rows('SELECT id FROM customers WHERE id=$1 AND name=$2', [s.customerId, s.deviceId]);
      if (owned.length !== 1) throw Error('OWN_CUSTOMER_GUARD_FAILED');
      if (action === 'arm') {
        await q(
          "INSERT INTO device_commands(id,device_id,customer_id,command,category,high_risk,status,requested_by,request_time,timeout_sec,expires_at,updated_at) VALUES($1,$2,$3,'FORCE_SYNC','DEVICE',false,'AUTHORIZED',$2,now(),900,now()+interval '15 minutes',now())",
          [s.commandId, s.deviceId, s.customerId],
        );
        await q(
          "INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) VALUES($1,'COMMAND_PUBLISH_REQUESTED','device_command',$2,$3,$4::jsonb)",
          [
            randomUUID(),
            s.commandId,
            'COMMAND_PUBLISH_REQUESTED:' + s.commandId,
            JSON.stringify({ commandId: s.commandId }),
          ],
        );
        await q(
          "INSERT INTO firmware_packages(id,version,model,package_type,sha256,size_bytes,s3_key,status,uploaded_by) VALUES($1,$2,$2,'FIRMWARE',$3,$4,$5,'VERIFIED',$2)",
          [s.packageId, s.deviceId, s.packageHash, s.packageBytes, s.packageKey],
        );
        await q(
          "INSERT INTO ota_campaigns(id,name,package_id,target_model,status,created_by,updated_at) VALUES($1,$2,$3,$2,'RUNNING',$2,now())",
          [s.campaignId, s.deviceId, s.packageId],
        );
        await q(
          "INSERT INTO ota_targets(id,campaign_id,device_id,batch_no,status,updated_at) VALUES($1,$2,$3,1,'PENDING',now())",
          [s.targetId, s.campaignId, s.deviceId],
        );
        await q(
          "INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) VALUES($1,'SYNC_REQUIRED','device',$2,$3,$4::jsonb)",
          [
            s.notificationId,
            s.deviceId,
            'mqtt-business:' + s.deviceId,
            JSON.stringify({
              topic: `bnx/device/${s.deviceId}/notification`,
              data: {
                type: 'SYNC_REQUIRED',
                priority: 'NORMAL',
                title: 'Isolated MQTT probe',
                message: s.deviceId,
                action: 'SYNC',
              },
            }),
          ],
        );
      } else if (action === 'quiesce') {
        await q("UPDATE ota_campaigns SET status='CANCELLED',updated_at=now() WHERE id=$1", [s.campaignId]);
        await q(
          "UPDATE device_commands SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status IN('AUTHORIZED','PUBLISH_FAILED')",
          [s.commandId],
        );
      } else if (action === 'cleanup') {
        const removed = {};
        for (const [table, condition, args] of [
          ['outbox_events', "aggregate_id=ANY($1::text[]) OR payload->>'deviceId'=$2", [ids, s.deviceId]],
          ['command_acks', 'command_id=$1', [s.commandId]],
          ['command_attempts', 'command_id=$1', [s.commandId]],
          ['device_commands', 'id=$1', [s.commandId]],
          ['ota_download_grants', 'target_id=$1', [s.targetId]],
          ['ota_status_history', 'target_id=$1', [s.targetId]],
          ['ota_targets', 'id=$1', [s.targetId]],
          ['ota_campaigns', 'id=$1', [s.campaignId]],
          ['firmware_packages', 'id=$1', [s.packageId]],
          ['media_objects', 'device_id=$1', [s.deviceId]],
          ['media_upload_sessions', 'device_id=$1', [s.deviceId]],
          ...[
            'telemetry_hourly',
            'telemetry_daily',
            'esg_reports',
            'esg_daily_summary',
            'alarms',
            'device_events',
            'tamper_events',
            'ingestion_receipts',
            'ingestion_gaps',
            'device_latest_state',
          ].map((t) => [t, 'device_id=$1', [s.deviceId]]),
          ['license_history', 'license_id=$1', [s.licenseId]],
          ['license_entitlements', 'license_id=$1', [s.licenseId]],
          ['licenses', 'id=$1', [s.licenseId]],
          ['device_assignments', 'device_id=$1', [s.deviceId]],
          ['device_certificates', 'device_id=$1', [s.deviceId]],
          ['devices', 'id=$1', [s.deviceId]],
          ['sites', 'id=$1', [s.siteId]],
        ])
          removed[table] = (await q(`DELETE FROM ${table} WHERE ${condition}`, args)).rowCount;
        await q(
          "UPDATE customers SET status='SUSPENDED',deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND name=$2",
          [s.customerId, s.deviceId],
        );
        await q('COMMIT');
        return { removed, auditLogsPreserved: true, auditCustomerTombstoneRetained: true };
      } else throw Error('ACTION_NOT_ALLOWED');
    }
    await q('COMMIT');
    return { action, committed: true };
  } catch (e) {
    await q('ROLLBACK');
    throw e;
  }
}
export async function handler(event) {
  const scope = validateScope(JSON.parse(process.env.MQTT_SCOPE));
  if (
    ![
      'preflight',
      'seed',
      'arm',
      'observe',
      'quiesce',
      'cleanup',
      'audit-empty',
      'read-archives',
      'put-media',
      'put-ota',
    ].includes(event?.action)
  )
    return { error: 'ACTION_NOT_ALLOWED' };
  const s3 = new S3Client({ region: 'ap-southeast-1' });
  if (process.env.MQTT_OBJECT_ONLY) {
    const type = process.env.MQTT_OBJECT_ONLY;
    if (event.action !== 'put-' + type || !['media', 'ota'].includes(type))
      return { scope: scope.deviceId, error: 'OBJECT_ONLY_ACTION_REQUIRED' };
    const body = Buffer.from(event.bodyBase64 ?? '', 'base64');
    const expected = type === 'media' ? scope.mediaHash : scope.packageHash;
    if (body.length > 8192 || createHash('sha256').update(body).digest('hex') !== expected)
      return { scope: scope.deviceId, error: 'OBJECT_HASH_MISMATCH' };
    const value = await s3.send(
      new PutObjectCommand({
        Bucket: 'fdp-test-' + type + '-065986019555',
        Key: type === 'media' ? scope.mediaKey : scope.packageKey,
        Body: body,
      }),
    );
    return { scope: scope.deviceId, result: { versionId: value.VersionId ?? null } };
  }
  if (event.action === 'read-archives') {
    const prefixes = ['telemetry', 'report', 'alarm', 'event', 'tamper', 'ack']
      .map((t) => `raw/topic_type=${t}/customer_id=${scope.customerId}/`)
      .concat(
        ['publication', 'result'].map(
          (t) => `operations/operation_type=ota/record_type=${t}/customer_id=${scope.customerId}/`,
        ),
      );
    const objects = [];
    for (const prefix of prefixes) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: 'fdp-test-raw-065986019555', Prefix: prefix }));
      if (page.IsTruncated || (page.Contents ?? []).length > 100) throw Error('ARCHIVE_SCOPE_LIMIT');
      for (const item of page.Contents ?? []) {
        if ((item.Size ?? 0) > 1048576) throw Error('ARCHIVE_SIZE_LIMIT');
        const got = await s3.send(new GetObjectCommand({ Bucket: 'fdp-test-raw-065986019555', Key: item.Key }));
        const bytes = await got.Body.transformToByteArray();
        objects.push({ key: item.Key, base64: Buffer.from(bytes).toString('base64') });
      }
    }
    if (JSON.stringify(objects).length > 4194304) throw Error('ARCHIVE_RESPONSE_LIMIT');
    return { scope: scope.deviceId, result: { objects } };
  }
  let client;
  try {
    const secret = JSON.parse(
      (await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }))).SecretString,
    );
    if (secret.host !== 'fdp-test-db.c30ie84saulu.ap-southeast-1.rds.amazonaws.com' || secret.dbname !== 'fdp')
      throw Error('WRONG_DB_TARGET');
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
    return {
      scope: scope.deviceId,
      action: event.action,
      result: await execute(client, event.action, scope, event.certificate),
    };
  } catch (e) {
    return {
      scope: scope.deviceId,
      action: event.action,
      error: {
        code: e.code ?? 'FIXTURE_ERROR',
        message: String(e.message)
          .replace(/password[^\s]*/gi, 'REDACTED')
          .slice(0, 220),
      },
    };
  } finally {
    await client?.end().catch(() => {});
  }
}
