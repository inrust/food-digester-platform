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
  if (
    !/^qa09-[a-f0-9]{16}$/.test(plan.prefix ?? '') ||
    ![
      'seed',
      'observe',
      'cleanup',
      'audit-closed',
      'cleanup-closed',
      'audit-empty',
      'audit-unseeded-prefix',
      'capacity-readonly',
      'capacity-pool-readonly',
      'business-baseline',
      'business-cleanup',
      'business-audit',
      'business-seed-alarm',
      'business-seed-devices',
      'business-seed-active-lifecycle',
      'business-inject-export-lease',
    ].includes(plan.action)
  )
    throw Error('INVALID_FIXTURE_PLAN');
  if (plan.action === 'audit-unseeded-prefix' && (!Array.isArray(plan.customers) || plan.customers.length !== 0))
    throw Error('UNSEEDED_AUDIT_REQUIRES_EMPTY_CUSTOMER_LEDGER');
  const ids = Array.from({ length: 10 }, (_, i) => `${plan.prefix}-${String(i + 1).padStart(2, '0')}`);
  if (JSON.stringify(plan.devices) !== JSON.stringify(ids)) throw Error('EXACT_TEN_REQUIRED');
  if (
    plan.action !== 'audit-unseeded-prefix' &&
    (!Array.isArray(plan.customers) ||
      plan.customers.length !== 2 ||
      plan.customers.some(
        (c) =>
          !/^[a-f0-9-]{36}$/.test(c.id) || c.name !== `${plan.prefix}-${c.suffix}` || !['a', 'b'].includes(c.suffix),
      ) ||
      plan.customers[0].id === plan.customers[1].id)
  )
    throw Error('OWN_CUSTOMERS_REQUIRED');
  if (
    plan.action.endsWith('-closed') &&
    (!Array.isArray(plan.requestLedger) ||
      plan.requestLedger.length !== 10 ||
      new Set(plan.requestLedger.map((r) => r.requestId)).size !== 10 ||
      plan.requestLedger.some(
        (r, i) =>
          r.deviceId !== ids[i] || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.requestId),
      ))
  )
    throw Error('OWN_REQUEST_LEDGER_REQUIRED');
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
  if (plan.action === 'capacity-pool-readonly') throw Error('POOL_PROBE_REQUIRES_FIXED_RUNNER_POOL');
  let committed = false;
  try {
    await client.query(
      [
        'observe',
        'audit-closed',
        'audit-empty',
        'audit-unseeded-prefix',
        'capacity-readonly',
        'capacity-pool-readonly',
        'business-baseline',
        'business-audit',
      ].includes(plan.action)
        ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    );
    await client.query("SET LOCAL statement_timeout='10000ms'");
    await client.query("SET LOCAL lock_timeout='2000ms'");
    if ((await client.query('SELECT current_database() AS database')).rows[0].database !== 'fdp')
      throw Error('WRONG_DATABASE');
    const before = await original(client, ids);
    if (plan.action === 'audit-unseeded-prefix') {
      const customers = (
        await client.query(
          'SELECT id,name,status,deleted_at FROM customers WHERE name=ANY($1::text[]) ORDER BY name,id',
          [[plan.prefix + '-a', plan.prefix + '-b']],
        )
      ).rows;
      const devices = (
        await client.query(
          'SELECT id,serial_number,customer_id FROM devices WHERE id=ANY($1::text[]) OR serial_number=ANY($1::text[]) ORDER BY id',
          [ids],
        )
      ).rows;
      await client.query('ROLLBACK');
      committed = true;
      return { customers, devices, originalFingerprints: before, writes: 0 };
    }
    if (plan.action === 'capacity-readonly') {
      const settings = (
        await client.query(
          "SELECT name,setting FROM pg_settings WHERE name IN('max_connections','superuser_reserved_connections','reserved_connections','rds.rds_superuser_reserved_connections','rds.rds_reserved_connections') ORDER BY name",
        )
      ).rows;
      const sessions = (
        await client.query(
          'SELECT backend_type,state,count(*)::int AS connections FROM pg_stat_activity GROUP BY backend_type,state ORDER BY backend_type,state',
        )
      ).rows;
      const readOnly = (await client.query("SELECT current_setting('transaction_read_only') AS read_only")).rows[0]
        .read_only;
      if (readOnly !== 'on') throw Error('CAPACITY_PROBE_NOT_READ_ONLY');
      await client.query('ROLLBACK');
      committed = true;
      return {
        scope: 'LIVE_DATABASE_CONNECTION_CAPACITY_READ_ONLY',
        settings,
        sessions,
        transactionReadOnly: true,
        writes: 0,
        originalFingerprints: before,
      };
    }
    if (plan.action === 'business-seed-active-lifecycle') {
      for (const c of plan.customers)
        if (
          (
            await client.query('SELECT id FROM customers WHERE id=$1 AND name=$2 AND deleted_at IS NULL', [
              c.id,
              c.name,
            ])
          ).rowCount !== 1
        )
          throw Error('CUSTOMER_SCOPE_DRIFT');
      const target = ids.slice(0, 2);
      const states = (
        await client.query('SELECT id,lifecycle_status FROM devices WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [
          target,
        ])
      ).rows;
      if (states.length !== 2 || states.some((x) => !['Onboarded', 'Assigned'].includes(x.lifecycle_status)))
        throw Error('ACTIVE_FIXTURE_PRECONDITION_DRIFT');
      const changed = await client.query(
        "UPDATE devices SET lifecycle_status='Active',updated_at=now() WHERE id=ANY($1::text[]) AND lifecycle_status IN('Onboarded','Assigned')",
        [target],
      );
      if (changed.rowCount !== 2 || JSON.stringify(before) !== JSON.stringify(await original(client, ids)))
        throw Error('ACTIVE_FIXTURE_SCOPE_DRIFT');
      await client.query('COMMIT');
      committed = true;
      return {
        fixtureMode: 'EXACT_TWO_ACTIVE_PRECONDITION_ONLY_NOT_NATURAL_LIFECYCLE_ACCEPTANCE',
        beforeStates: states,
        changedDeviceIds: target,
        originalFingerprints: before,
      };
    }
    if (plan.action === 'business-seed-devices') {
      for (const c of plan.customers)
        if (
          (
            await client.query('SELECT id FROM customers WHERE id=$1 AND name=$2 AND deleted_at IS NULL', [
              c.id,
              c.name,
            ])
          ).rowCount !== 1
        )
          throw Error('CUSTOMER_SCOPE_DRIFT');
      if (
        (await client.query('SELECT id FROM devices WHERE id=ANY($1::text[]) OR serial_number=ANY($1::text[])', [ids]))
          .rowCount
      )
        throw Error('FIXTURES_ALREADY_EXIST');
      for (const [i, id] of ids.entries())
        await client.query(
          "INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,lifecycle_status,customer_id,updated_at) VALUES($1,$1,'BNX-100','1','Bio-Nexa','2026-01-01','Onboarded',$2,now())",
          [id, plan.customers[i < 5 ? 0 : 1].id],
        );
      const devices = (
        await client.query(
          'SELECT id,serial_number,customer_id,lifecycle_status FROM devices WHERE id=ANY($1::text[]) ORDER BY id',
          [ids],
        )
      ).rows;
      if (devices.length !== 10 || JSON.stringify(before) !== JSON.stringify(await original(client, ids)))
        throw Error('ORIGINAL_DEVICE_OR_CERTIFICATE_CHANGED');
      await client.query('COMMIT');
      committed = true;
      return {
        devices,
        originalFingerprints: before,
        fixtureMode: 'REAL_RDS_ONBOARDED_STATE_FOR_BUSINESS_APIS_NO_DEVICE_AUTH_CLAIM',
      };
    }
    if (plan.action === 'business-seed-alarm') {
      const c = plan.customers[0];
      if (
        (await client.query('SELECT id FROM customers WHERE id=$1 AND name=$2 AND deleted_at IS NULL', [c.id, c.name]))
          .rowCount !== 1 ||
        (await client.query('SELECT id FROM devices WHERE id=$1 AND customer_id=$2', [ids[0], c.id])).rowCount !== 1
      )
        throw Error('OWN_ALARM_SCOPE_DRIFT');
      if (!/^[a-f0-9-]{36}$/.test(plan.alarmId ?? '')) throw Error('OWN_ALARM_LEDGER_REQUIRED');
      await client.query(
        "INSERT INTO alarms(id,device_id,customer_id,code,category,severity,detected_time,updated_at) VALUES($1,$2,$3,'QA09_TEST','SYSTEM','WARNING',now(),now())",
        [plan.alarmId, ids[0], c.id],
      );
      await client.query('COMMIT');
      committed = true;
      return { alarmId: plan.alarmId };
    }
    if (plan.action === 'business-inject-export-lease') {
      if (
        plan.faultAuthorization !== 'USER_CONFIRMED_OWN_FIXTURE_ONLY_2026_10_03' ||
        !/^[a-f0-9-]{36}$/.test(plan.exportId ?? '')
      )
        throw Error('OWN_FAULT_AUTHORIZATION_REQUIRED');
      const c = plan.customers[0];
      const changed = await client.query(
        "UPDATE esg_export_jobs SET status='PROCESSING',lease_until=now()-interval '1 second',lease_token=$4 WHERE id=$1 AND customer_id=$2 AND filters->>'deviceId'=$3 AND status IN('PENDING','COMPLETED','FAILED') RETURNING id,status,lease_until<now() AS expired",
        [plan.exportId, c.id, ids[0], plan.exportId],
      );
      if (changed.rowCount !== 1) throw Error('OWN_EXPORT_NOT_READY_FOR_INJECTION');
      await client.query('COMMIT');
      committed = true;
      return { exportLease: changed.rows[0], originalFingerprints: before };
    }
    if (plan.action.startsWith('business-')) {
      const customers = plan.customers.map((c) => c.id);
      for (const c of plan.customers)
        if ((await client.query('SELECT id FROM customers WHERE id=$1 AND name=$2', [c.id, c.name])).rowCount !== 1)
          throw Error('CUSTOMER_SCOPE_DRIFT');
      const scopes = [
        [
          'outbox_events',
          'aggregate_id=ANY($1::text[]) OR aggregate_id IN(SELECT id FROM device_commands WHERE device_id=ANY($1::text[])) OR aggregate_id IN(SELECT id FROM licenses WHERE customer_id=ANY($2::text[]) UNION ALL SELECT id FROM contracts WHERE customer_id=ANY($2::text[]) UNION ALL SELECT id FROM device_users WHERE customer_id=ANY($2::text[]))',
          [ids, customers],
        ],
        ['command_acks', 'command_id IN(SELECT id FROM device_commands WHERE device_id=ANY($1::text[]))', ids],
        ['command_attempts', 'command_id IN(SELECT id FROM device_commands WHERE device_id=ANY($1::text[]))', ids],
        ['device_commands', 'device_id=ANY($1::text[])', ids],
        ['device_retirements', 'device_id=ANY($1::text[])', ids],
        ['device_user_sync_receipts', 'device_id=ANY($1::text[])', ids],
        ['device_user_assignments', 'customer_id=ANY($1::text[])', customers],
        ['device_users', 'customer_id=ANY($1::text[])', customers],
        ['license_history', 'license_id IN(SELECT id FROM licenses WHERE customer_id=ANY($1::text[]))', customers],
        ['license_entitlements', 'license_id IN(SELECT id FROM licenses WHERE customer_id=ANY($1::text[]))', customers],
        ['contract_devices', 'customer_id=ANY($1::text[])', customers],
        ['licenses', 'customer_id=ANY($1::text[])', customers],
        ['contracts', 'customer_id=ANY($1::text[])', customers],
        [
          'configuration_versions',
          'configuration_id IN(SELECT id FROM device_configurations WHERE target_device_id=ANY($1::text[]))',
          ids,
        ],
        ['device_configurations', 'target_device_id=ANY($1::text[])', ids],
        ['consumable_requests', 'customer_id=ANY($1::text[])', customers],
        ['esg_export_jobs', 'customer_id=ANY($1::text[])', customers],
        ['device_assignments', 'device_id=ANY($1::text[])', ids],
        ['device_user_sync_receipts', 'device_id=ANY($1::text[])', ids],
      ];
      const outside = async () =>
        Promise.all(
          scopes
            .filter((s, i, a) => a.findIndex((x) => x[0] === s[0]) === i)
            .map(async ([table, predicate, args]) => ({
              table,
              ...(
                await client.query(
                  `SELECT count(*)::text,md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM public."${table}" t WHERE NOT COALESCE((${predicate}),false)`,
                  table === 'outbox_events' ? args : [args],
                )
              ).rows[0],
            })),
        );
      const fingerprint = await outside();
      const counts = {};
      const deleted = {};
      if (plan.action === 'business-cleanup') {
        if (
          !Array.isArray(plan.businessBaseline) ||
          JSON.stringify(fingerprint) !== JSON.stringify(plan.businessBaseline)
        )
          throw Error('BUSINESS_BASELINE_DRIFT');
        const objects = (
          await client.query(
            'SELECT id FROM licenses WHERE customer_id=ANY($1::text[]) UNION ALL SELECT id FROM contracts WHERE customer_id=ANY($1::text[]) UNION ALL SELECT id FROM device_users WHERE customer_id=ANY($1::text[])',
            [customers],
          )
        ).rows.map((r) => r.id);
        await client.query('UPDATE devices SET site_id=NULL WHERE id=ANY($1::text[]) AND customer_id=ANY($2::text[])', [
          ids,
          customers,
        ]);
        deleted.business_outbox = (
          await client.query('DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[])', [objects])
        ).rowCount;
        for (const [table, predicate, args] of scopes)
          deleted[table] =
            (deleted[table] ?? 0) +
            (
              await client.query(
                `DELETE FROM public."${table}" WHERE ${predicate}`,
                table === 'outbox_events' ? args : [args],
              )
            ).rowCount;
      }
      for (const [table, predicate, args] of scopes)
        counts[table] = Number(
          (
            await client.query(
              `SELECT count(*)::text AS count FROM public."${table}" WHERE ${predicate}`,
              table === 'outbox_events' ? args : [args],
            )
          ).rows[0].count,
        );
      const after = await outside();
      if (JSON.stringify(fingerprint) !== JSON.stringify(after)) throw Error('OUTSIDE_BUSINESS_DATA_CHANGED');
      if (
        plan.action === 'business-audit' &&
        (!Array.isArray(plan.businessBaseline) ||
          JSON.stringify(after) !== JSON.stringify(plan.businessBaseline) ||
          Object.values(counts).some((n) => n !== 0))
      )
        throw Error('BUSINESS_CLEANUP_NOT_VERIFIED');
      if (plan.action === 'business-cleanup') await client.query('COMMIT');
      else await client.query('ROLLBACK');
      committed = true;
      return { businessFingerprints: after, counts, deleted, originalFingerprints: before };
    }
    if (plan.action === 'audit-empty') {
      if (!Array.isArray(plan.baseline)) throw Error('ORIGINAL_BASELINE_REQUIRED');
      for (const c of plan.customers)
        if (
          (
            await client.query('SELECT id FROM customers WHERE id=$1 AND name=$2 AND deleted_at IS NOT NULL', [
              c.id,
              c.name,
            ])
          ).rowCount !== 1
        )
          throw Error('CLOSED_CUSTOMER_NOT_VERIFIED');
      for (const [table, column] of [
        ['devices', 'id'],
        ['device_certificates', 'device_id'],
        ['onboarding_requests', 'serial_number'],
      ])
        if ((await client.query(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1::text[])`, [ids])).rowCount)
          throw Error('FIXTURE_NOT_EMPTY');
      if (JSON.stringify(before) !== JSON.stringify(plan.baseline)) throw Error('ORIGINAL_BASELINE_DRIFT');
      await client.query('ROLLBACK');
      committed = true;
      return { empty: true, devices: [], certificates: [], onboardingRequests: [], originalFingerprints: before };
    }
    if (plan.action.endsWith('-closed')) {
      for (const c of plan.customers)
        if (
          (
            await client.query('SELECT id FROM customers WHERE id=$1 AND name=$2 AND deleted_at IS NOT NULL', [
              c.id,
              c.name,
            ])
          ).rowCount !== 1
        )
          throw Error('CLOSED_CUSTOMER_NOT_VERIFIED');
      for (const [table, column] of [
        ['devices', 'id'],
        ['device_certificates', 'device_id'],
        ['onboarding_requests', 'serial_number'],
      ])
        if ((await client.query(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1::text[])`, [ids])).rowCount)
          throw Error('FIXTURE_NOT_CLOSED');
      const requestIds = plan.requestLedger.map((r) => r.requestId);
      const audit = (
        await client.query(
          "SELECT object_id,action,result,CASE WHEN reason ~* '(private|secret|password|token|BEGIN|arn:aws|access.?key|certificatepem)' THEN 'REDACTED' ELSE left(reason,500) END AS reason FROM audit_logs WHERE object_type='onboarding_request' AND object_id=ANY($1::text[]) ORDER BY created_at LIMIT 200",
          [requestIds],
        )
      ).rows;
      if (
        requestIds.some(
          (id) =>
            !audit.some(
              (a) => a.object_id === id && a.action === 'onboarding.request.approve' && a.result === 'SUCCESS',
            ),
        )
      )
        throw Error('REQUEST_APPROVAL_AUDIT_MISSING');
      const outbox = (
        await client.query(
          "SELECT id,event_type,aggregate_id,status FROM outbox_events WHERE aggregate_type='onboarding_request' AND aggregate_id=ANY($1::text[]) AND payload->>'requestId'=aggregate_id ORDER BY id",
          [requestIds],
        )
      ).rows;
      if (outbox.some((o) => o.event_type !== 'ONBOARDING_PROVISIONING_FAILED'))
        throw Error('UNEXPECTED_REQUEST_OUTBOX');
      let deleted = 0;
      if (plan.action === 'cleanup-closed')
        deleted = (
          await client.query(
            "DELETE FROM outbox_events WHERE event_type='ONBOARDING_PROVISIONING_FAILED' AND aggregate_type='onboarding_request' AND aggregate_id=ANY($1::text[]) AND payload->>'requestId'=aggregate_id",
            [requestIds],
          )
        ).rowCount;
      const after = await original(client, ids);
      if (
        JSON.stringify(before) !== JSON.stringify(after) ||
        (plan.baseline && JSON.stringify(after) !== JSON.stringify(plan.baseline))
      )
        throw Error('ORIGINAL_BASELINE_DRIFT');
      if (plan.action === 'audit-closed') await client.query('ROLLBACK');
      else await client.query('COMMIT');
      committed = true;
      return { audit, outbox, deletedRequestOutbox: deleted, originalFingerprints: after };
    }
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
        "SELECT j.id,j.status,j.attempts,j.issued_certificate_id,CASE WHEN j.last_error ~* '(private|secret|password|token|BEGIN|arn:aws|access.?key|certificatepem)' THEN split_part(j.last_error,':',1)||': REDACTED' ELSE left(j.last_error,500) END AS failure_reason FROM onboarding_provisioning_jobs j JOIN onboarding_requests r ON r.id=j.request_id WHERE r.serial_number=ANY($1::text[]) ORDER BY r.serial_number",
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
      deleted.request_outbox = (
        await client.query(
          "DELETE FROM outbox_events WHERE event_type='ONBOARDING_PROVISIONING_FAILED' AND aggregate_type='onboarding_request' AND aggregate_id IN(SELECT id FROM onboarding_requests WHERE serial_number=ANY($1::text[])) AND payload->>'requestId'=aggregate_id",
          [ids],
        )
      ).rowCount;
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
      receipts: plan.action === 'cleanup' ? [] : receipts,
      latest,
      outbox: plan.action === 'cleanup' ? [] : outbox,
      ...(plan.action === 'cleanup'
        ? { observedBeforeCleanupCounts: { receipts: receipts.length, outbox: outbox.length } }
        : {}),
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
export async function executePoolReadOnly(pool, applicationName) {
  if (!/^qa09-pool-[a-f0-9]{16}$/.test(applicationName)) throw Error('INVALID_POOL_PROBE_SCOPE');
  const params = (
    await pool.query(
      "SELECT current_setting('max_connections')::int AS max_connections,current_setting('superuser_reserved_connections')::int AS superuser_reserved_connections,current_setting('reserved_connections')::int AS reserved_connections,current_setting('rds.rds_reserved_connections')::int AS rds_reserved_connections",
    )
  ).rows[0];
  const ordinarySlots =
    params.max_connections -
    params.superuser_reserved_connections -
    params.reserved_connections -
    params.rds_reserved_connections;
  if (ordinarySlots < 62) throw Error('LIVE_CONNECTION_BUDGET_INSUFFICIENT');
  const pids = new Set();
  let maxObservedOwnConnections = 0;
  const observe = async (connection) => {
    const row = (
      await connection.query(
        "SELECT pg_backend_pid() AS pid,(SELECT count(*)::int FROM pg_stat_activity WHERE application_name=$1 AND backend_type='client backend') AS own_connections",
        [applicationName],
      )
    ).rows[0];
    pids.add(row.pid);
    maxObservedOwnConnections = Math.max(maxObservedOwnConnections, row.own_connections);
  };
  const results = await Promise.all(
    Array.from({ length: 24 }, async (_, i) => {
      if (i % 2 === 0) {
        await Promise.all(Array.from({ length: 7 }, () => observe(pool)));
        return 'READ_BATCH';
      }
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN READ ONLY');
        await connection.query("SET LOCAL statement_timeout='3000ms'");
        await observe(connection);
        if (i === 1) {
          try {
            await connection.query('SELECT 1/0');
            throw Error('EXPECTED_READ_ERROR_MISSING');
          } catch (e) {
            if (e.code !== '22012') throw e;
          }
          return 'ROLLED_BACK_READ_ERROR';
        }
        await connection.query('SELECT pg_sleep(0.01)');
        return 'READ_TRANSACTION';
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
    }),
  );
  await pool.query('SELECT 1');
  if (
    pids.size !== 1 ||
    maxObservedOwnConnections !== 1 ||
    pool.totalCount !== 1 ||
    pool.waitingCount !== 0 ||
    results.filter((r) => r === 'ROLLED_BACK_READ_ERROR').length !== 1
  )
    throw Error('POOL_ONE_BOUNDARY_NOT_PROVED');
  return {
    scope: 'REAL_POSTGRES_TCP_READ_ONLY_POOL1_NOT_PRISMA_OR_HTTP_CAPACITY_ACCEPTANCE',
    databaseParameters: params,
    ordinarySlots,
    poolMax: 1,
    parallelTasks: 24,
    concurrentReadBatches: 12,
    readQueriesPerBatch: 7,
    readTransactions: 12,
    expectedReadErrorsRolledBack: 1,
    maxObservedOwnConnections,
    backendPidCount: pids.size,
    waitingAtEnd: pool.waitingCount,
    databaseWrites: 0,
    gate: 'PASS',
  };
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
  const { Client, Pool } = createRequire(resolve('package.json'))('pg');
  const connectionConfig = {
    host: secret.host,
    port: 5432,
    user: secret.username,
    password: secret.password,
    database: 'fdp',
    connectionTimeoutMillis: 10000,
    ssl: { ca: readFileSync('rds-ca-bundle.pem', 'utf8'), rejectUnauthorized: true },
  };
  if (plan.action === 'capacity-pool-readonly') {
    const applicationName = 'qa09-pool-' + plan.prefix.slice(5);
    const pool = new Pool({
      ...connectionConfig,
      max: 1,
      options: '-c default_transaction_read_only=on',
      idleTimeoutMillis: 10000,
      application_name: applicationName,
    });
    try {
      const result = await executePoolReadOnly(pool, applicationName);
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
      await pool.end();
    }
    return;
  }
  const client = new Client(connectionConfig);
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
