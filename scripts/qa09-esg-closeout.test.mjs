import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseEnvelope } from '../apps/ingestion-worker/src/ingest/envelope.ts';
import { createTestDb } from '../apps/cloud-api/test/helpers.ts';
import { createTelemetryHandler } from '../apps/ingestion-worker/src/telemetry/handler.ts';
import { createReportHandler } from '../apps/ingestion-worker/src/report/handler.ts';
import { createHeartbeatHandler } from '../apps/ingestion-worker/src/heartbeat/handler.ts';
import { createAggregationWorker } from '../apps/summary-worker/src/aggregation/worker.ts';
import { createArchiveWorker } from '../apps/ingestion-worker/src/archive/worker.ts';
import { processEsgExportJob } from '../apps/cloud-api/src/admin/esg/export-service.ts';
import { createAdminEsgHandlers } from '../apps/cloud-api/src/admin/esg/handler.ts';
import { readEsgList } from './qa09-esg-api.mjs';
import { SimulatedDevice } from './device-simulator/core.mjs';
import { canonical, verifyArchiveObjects } from './qa09-archive-probe.mjs';
import { sha256 } from './qa09-reliability-closeout.mjs';
import { executeFixture, validatePlan } from './qa09-ten-device-db.mjs';
import { assertOwnS3Request } from './qa09-own-s3-cli.mjs';
import {
  assertConsistency,
  parseCsv,
  assertCsvDatabase,
  assertLeaseRecovery,
  cleanupFailureRequiresHold,
  waitRead,
} from './qa09-esg-closeout.mjs';
// Match the UTC CodeBuild runtime when reading PostgreSQL timestamp columns.
process.env.TZ = 'UTC';
const prefix = 'qa09-1234567890abcdef';
const devices = Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0'));
const customers = ['a', 'b'].map((suffix) => ({ id: randomUUID(), name: prefix + '-' + suffix, suffix }));
test('HTTP empty lists are valid natural-wait observations; missing data never implies empty', () => {
  const scope = { deviceId: devices[0], customerId: customers[0].id };
  const response = {
    data: [],
    meta: { requestId: 'actual-handler-shape', timestamp: '2026-10-13T01:00:00.000Z', nextCursor: null },
  };
  assert.deepEqual(readEsgList(response, scope), []);
  for (const bad of [{ ...response, data: null }, { ...response, data: { items: [] } }, { data: [] }])
    assert.throws(() => readEsgList(bad, scope), /HTTP_RESPONSE/);
});
test('actual PostgreSQL telemetry/report handlers, aggregation, archive manifests and four exports agree without Active', async () => {
  const { pg, prisma } = await createTestDb(),
    telemetry = [],
    reports = [],
    published = [],
    exportIds = [];
  const client = {
    query: async (q, args) =>
      q === 'SELECT current_database() AS database' ? { rows: [{ database: 'fdp' }] } : pg.query(q, args),
  };
  const plan = (action, extra = {}) => ({ prefix, devices, customers, action, ...extra });
  try {
    for (const c of customers) await prisma.customer.create({ data: { id: c.id, name: c.name } });
    const handlers = {
      telemetry: createTelemetryHandler({ client: prisma }),
      report: createReportHandler({ client: prisma }),
      heartbeat: createHeartbeatHandler({ client: prisma }),
    };
    for (const [i, id] of devices.entries()) {
      const customerId = customers[i < 5 ? 0 : 1].id;
      await prisma.device.create({
        data: {
          id,
          serialNumber: id,
          model: 'BNX-100',
          hardwareVersion: '1',
          manufacturer: 'QA',
          manufactureDate: new Date('2026-01-01'),
          lifecycleStatus: 'Onboarded',
          customerId,
        },
      });
      let now = new Date('2026-10-13T00:59:00Z');
      const sim = new SimulatedDevice(id, {}, {}, () => now);
      for (const type of ['heartbeat', 'telemetry', 'telemetry', ...(i === 0 || i === 5 ? ['report'] : [])]) {
        now = new Date(now.getTime() + 60000);
        const defaults = type === 'report' ? sim.payload('report').data : undefined;
        const payload = sim.payload(
          type,
          type === 'report'
            ? { ...defaults, periodStartTime: '2026-10-13T01:00:00.000Z', periodEndTime: '2026-10-13T01:02:00.000Z' }
            : undefined,
        );

        const raw = JSON.stringify(payload),
          row = {
            deviceId: id,
            type,
            messageId: payload.meta.id,
            seq: payload.meta.seq,
            occurredAt: payload.meta.ts,
            data: payload.data,
            bodySha256: sha256(raw),
            payloadSha256: sha256(canonical(payload)),
          };
        published.push(row);
        const message = {
          envelope: parseEnvelope(
            JSON.stringify({
              ...payload,
              iotTopic: `bnx/device/${id}/${type}`,
              iotDeviceId: id,
              iotType: type,
              iotReceivedAt: now.getTime(),
              iotPrincipal: 'cert',
            }),
          ),
          rawBody: JSON.stringify({
            ...payload,
            iotTopic: `bnx/device/${id}/${type}`,
            iotDeviceId: id,
            iotType: type,
            iotReceivedAt: now.getTime(),
            iotPrincipal: 'cert',
          }),
          rawPayload: payload,
          normalizedPayload: payload,
          device: {
            deviceId: id,
            customerId,
            siteId: null,
            lifecycleStatus: 'Onboarded',
            certificateId: 'cert',
            certificateFingerprint: 'a'.repeat(64),
          },
          messageId: payload.meta.id,
          occurredAt: payload.meta.ts,
          data: payload.data,
          audit: payload.audit ?? null,
        };
        await handlers[type](message);
        if (type === 'telemetry') {
          telemetry.push(row);
          await handlers[type](message);
        }
        if (type === 'report') {
          reports.push(row);
          await handlers[type](message);
        }
      }
    }
    await createAggregationWorker({ client: prisma }).recomputeWindow({
      from: new Date('2026-10-13T00:00:00Z'),
      to: new Date('2026-10-13T23:59:59Z'),
    });
    await prisma.outboxEvent.updateMany({
      where: { eventType: 'ARCHIVE', aggregateId: { in: devices } },
      data: { status: 'PUBLISHED' },
    });
    const frame = await executeFixture(client, plan('consistency-observe'));
    assert.equal(
      assertConsistency(frame, telemetry, reports, devices, customers).gate,
      'PASS_REAL_MQTT_DAILY_ARCHIVE_ESG_CONSISTENCY',
    );
    for (const mutate of [
      (f) => f.telemetry_daily.pop(),
      (f) => {
        f.telemetry_daily[0].sample_count++;
      },
      (f) => {
        f.telemetry_daily[0].metrics.ambientTempC.avg++;
      },
      (f) => {
        f.telemetry_daily[0].customer_id = randomUUID();
      },
      (f) => {
        f.esg_daily_summary[0].carbon_reduction_kg = '999';
      },
      (f) => {
        f.esg_reports[0].source_message_id = 'foreign';
      },
      (f) => {
        f.receipts.find((r) => r.topic_type === 'telemetry').payload_hash = 'b'.repeat(64);
      },
      (f) => {
        f.outbox[0].raw_body_sha256 = null;
      },
      (f) => {
        f.outbox[0].status = 'PENDING';
      },
      (f) => {
        f.devices[0].lifecycle_status = 'Active';
      },
      (f) => {
        f.calculationVersions = [];
      },
    ]) {
      const bad = structuredClone(frame);
      mutate(bad);
      assert.throws(() => assertConsistency(bad, telemetry, reports, devices, customers), String(mutate));
    }
    const objects = new Map();
    const worker = createArchiveWorker({
      bucket: 'fdp-test-raw-065986019555',
      store: { putObject: async ({ key, body }) => objects.set(key, Buffer.from(body)) },
    });
    const outbox = await prisma.outboxEvent.findMany({ where: { eventType: 'ARCHIVE', aggregateId: { in: devices } } });
    const archive = await worker.archiveBatch(
      outbox.map((r) => ({
        eventId: r.id,
        eventType: r.eventType,
        aggregateType: r.aggregateType,
        aggregateId: r.aggregateId,
        createdAt: r.createdAt.toISOString(),
        payload: r.payload,
      })),
    );
    assert.equal(archive.objects.length, 22);
    const archivePlan = {
      prefix,
      devices,
      customers: customers.map((c) => c.id),
      published,
      profile: 'QA09_REPORT_CONSISTENCY',
      outbox: frame.outbox.map((o) => ({ id: o.id, rawBodySha256: o.raw_body_sha256 })),
    };
    const inputs = archive.objects.map((o) => ({
      key: o.key,
      bytes: objects.get(o.key),
      manifest: JSON.parse(objects.get(o.manifestKey).toString()),
    }));
    const proof = verifyArchiveObjects(archivePlan, inputs);
    assert.equal(proof.allReportsArchived, true);
    assert.equal(proof.archivedMessages, 22);
    assert.ok(proof.archiveObjects.every((o) => o.manifestMatched));
    const broken = structuredClone(inputs);
    broken[0].manifest.sha256 = '0'.repeat(64);
    assert.throws(() => verifyArchiveObjects(archivePlan, broken), /MANIFEST/);
    assert.throws(() => verifyArchiveObjects(archivePlan, inputs.slice(1)), /ARCHIVE_MISSING/);
    // Even matching ingress/S3 byte hashes cannot hide a different payload or forged context.
    for (const field of ['iotDeviceId', 'data']) {
      const badInputs = structuredClone(inputs),
        badPlan = structuredClone(archivePlan);
      const lines = gunzipSync(badInputs[0].bytes).toString().trim().split('\n').map(JSON.parse);
      const envelope = JSON.parse(lines[0].rawBody);
      if (field === 'iotDeviceId') envelope.iotDeviceId = devices[9];
      else envelope.data = { ...envelope.data, injectedMetric: 999 };
      lines[0].rawBody = JSON.stringify(envelope);
      badPlan.outbox.find((o) => o.id === lines[0].eventId).rawBodySha256 = sha256(lines[0].rawBody);
      badInputs[0].bytes = gzipSync(lines.map(JSON.stringify).join('\n') + '\n');
      badInputs[0].manifest.sha256 = sha256(badInputs[0].bytes);
      assert.throws(() => verifyArchiveObjects(badPlan, badInputs), /INGRESS_CONTEXT_OR_PAYLOAD/);
    }
    const bodies = new Map(),
      actor = { actorId: randomUUID(), actorType: 'platform', roles: ['PlatformSuperAdmin'] };
    let clock = new Date();
    const deps = {
      client: prisma,
      now: () => clock,
      storage: { put: async ({ key, body }) => bodies.set(key, body) },
      urlSigner: { sign: ({ key }) => 'https://test.invalid/' + key },
    };
    const http = createAdminEsgHandlers(deps);
    const req = (extra) => ({ actor, headers: {}, requestId: 'qa09-esg-real-handler', ...extra });
    for (const dataset of ['HOURLY', 'DAILY', 'REPORTS', 'DAILY_SUMMARY']) {
      const query = { customerId: customers[0].id, deviceId: devices[0], limit: '100' };
      const listMethod = {
        HOURLY: 'listHourly',
        DAILY: 'listDaily',
        REPORTS: 'listReports',
        DAILY_SUMMARY: 'listDailySummary',
      }[dataset];
      const listed = await http[listMethod](req({ query }));
      assert.equal(listed.status, 200);
      assert.ok(readEsgList(listed.body, query).length > 0);
      assert.throws(() => readEsgList({ ...listed.body, data: { items: listed.body.data } }, query), /HTTP_RESPONSE/);
      assert.throws(
        () => readEsgList({ ...listed.body, meta: { ...listed.body.meta, nextCursor: 'more' } }, query),
        /HTTP_RESPONSE/,
      );
      assert.throws(
        () => readEsgList({ ...listed.body, data: [{ ...listed.body.data[0], deviceId: devices[5] }] }, query),
        /HTTP_RESPONSE/,
      );
      const response = await http.createExport(
        req({ body: { dataset, customerId: customers[0].id, deviceId: devices[0] } }),
      );
      assert.equal(response.status, 202);
      const created = response.body.data;
      exportIds.push(created.exportId);
      const view = await processEsgExportJob(deps, created.exportId),
        csv = bodies.get('esg-exports/' + created.exportId + '.csv');
      assert.equal(view.status, 'COMPLETED');
      const detail = await http.exportDetail(req({ params: { exportId: created.exportId } }));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.requestedBy, actor.actorId);
      assert.equal(detail.body.data.status, 'COMPLETED');
      assert.equal(assertCsvDatabase(csv, dataset, frame, devices[0], customers[0].id).rowCount, view.rowCount);
      assert.throws(
        () => assertCsvDatabase(csv.replace(devices[0], devices[5]), dataset, frame, devices[0], customers[0].id),
        /VALUE_DRIFT/,
      );
      if (dataset === 'HOURLY') {
        const before = (await executeFixture(client, plan('consistency-observe', { semanticExportIds: exportIds })))
          .exports[0];
        await assert.rejects(
          executeFixture(
            client,
            plan('business-inject-export-lease', {
              semanticExportIds: exportIds,
              exportId: created.exportId,
              exportRequestedBy: randomUUID(),
              faultAuthorization: 'USER_CONFIRMED_OWN_FIXTURE_ONLY_2026_10_03',
            }),
          ),
          /NOT_READY/,
        );
        const injected = await executeFixture(
          client,
          plan('business-inject-export-lease', {
            semanticExportIds: exportIds,
            exportId: created.exportId,
            exportRequestedBy: actor.actorId,
            faultAuthorization: 'USER_CONFIRMED_OWN_FIXTURE_ONLY_2026_10_03',
          }),
        );
        clock = new Date(clock.getTime() + 60000);
        await processEsgExportJob(deps, created.exportId);
        const after = (await executeFixture(client, plan('consistency-observe', { semanticExportIds: exportIds })))
            .exports[0],
          second = bodies.get('esg-exports/' + created.exportId + '.csv');
        assert.match(assertLeaseRecovery(before, injected.exportLease, after, csv, second).gate, /^PASS_/);
        assert.throws(
          () =>
            assertLeaseRecovery(
              before,
              injected.exportLease,
              { ...after, completed_at: before.completed_at },
              csv,
              second,
            ),
          /NOT_PROVEN/,
        );
        assert.throws(
          () => assertLeaseRecovery(before, injected.exportLease, after, csv, second + 'changed'),
          /NOT_PROVEN/,
        );
      }
    }
    const result = await executeFixture(client, plan('consistency-observe', { semanticExportIds: exportIds }));
    assert.equal(result.readOnly, true);
    assert.equal(result.exports.length, 4);
    const before = await prisma.device.count();
    await assert.rejects(
      executeFixture(
        client,
        plan('consistency-observe', { customers: [{ ...customers[0], name: prefix + '-b' }, customers[1]] }),
      ),
    );
    assert.equal(await prisma.device.count(), before);
  } finally {
    await prisma.$disconnect();
    await pg.close();
  }
});
test('CSV parser owns quoting, embedded newline, schema, truncation and size boundaries', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,y","line1\nline2"\r\n'), [
    ['a', 'b'],
    ['x,y', 'line1\nline2'],
  ]);
  for (const csv of [
    'a,b\n1,2\n',
    'a,b\r\n1\r\n',
    'a,b\r\n"missing,2\r\n',
    'a,b\r\n"x"bad,2\r\n',
    'a,b\r\n',
    'x'.repeat(1048577),
  ])
    assert.throws(() => parseCsv(csv));
});
test('natural schedule reads have a total deadline, own late completion and never invoke a worker', async () => {
  let clock = 0,
    calls = 0;
  const observations = [];
  const success = await waitRead(
    async () => ++calls,
    (n) => n === 2,
    {
      budgetMs: 100,
      intervalMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      observe: (r) => observations.push(r),
    },
  );
  assert.equal(success, 2);
  assert.equal(calls, 2);
  assert.equal(observations.length, 2);
  calls = 0;
  clock = 0;
  await assert.rejects(
    waitRead(
      async () => {
        calls++;
        clock += 21;
        return true;
      },
      Boolean,
      { budgetMs: 20, intervalMs: 1, now: () => clock, sleep: async () => {} },
    ),
    /DEADLINE/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    waitRead(
      async () => {
        calls++;
        throw Error('read failed');
      },
      Boolean,
      { budgetMs: 20, intervalMs: 1 },
    ),
    /read failed/,
  );
  assert.equal(calls, 1);
});
test('Report cleanup admits only exact own customer prefixes and retains closed action/UUID plans', () => {
  const key = 'raw/topic_type=report/customer_id=' + customers[0].id + '/part.json.gz';
  assert.doesNotThrow(() =>
    assertOwnS3Request(
      'delete-object',
      { Bucket: 'fdp-test-raw-065986019555', Key: key },
      customers.map((c) => c.id),
    ),
  );
  assert.throws(() =>
    assertOwnS3Request(
      'delete-object',
      { Bucket: 'fdp-test-raw-065986019555', Key: key.replace(customers[0].id, 'outside') },
      customers.map((c) => c.id),
    ),
  );
  assert.throws(() => validatePlan({ prefix, devices, customers, action: 'consistency-write' }));
});

test('unknown readonly audit preserves failure but cannot strand resources after proven cleanup commit', () => {
  const safe = { lastAction: 'business-audit', knownCleanupCommitted: true, existingHold: false };
  assert.equal(cleanupFailureRequiresHold(safe), false);
  for (const patch of [
    { lastAction: 'business-cleanup' },
    { lastAction: 'consistency-observe' },
    { knownCleanupCommitted: false },
    { existingHold: true },
    { existingHold: undefined },
  ])
    assert.equal(cleanupFailureRequiresHold({ ...safe, ...patch }), true);
});
