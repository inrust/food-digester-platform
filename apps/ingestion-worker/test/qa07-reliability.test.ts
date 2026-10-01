import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { assert, test } from 'vitest';
import { computeAuditHash } from '@fdp/contracts/mqtt/payload-normalization.js';
import { createReplayWorker, createReplayIngressSink, gapStatus } from '../src/index.js';
import { createAdminDeviceConsoleHandlers } from '../../cloud-api/src/admin/device-console/handler.js';
import { publishCommand } from '../../cloud-api/src/admin/command/publisher.js';
import { evaluateCommandTimeouts } from '../../cloud-api/src/admin/command/timeout.js';
import {
  buildLoadPlan,
  latencySummary,
  expectedAggregates,
  checkConsistency,
} from '../../../scripts/reliability-plan.mjs';
import type { PlannedMessage } from '../../../scripts/reliability-plan.mjs';
import { createQa03Fixture, sha } from './qa03-fixture.js';
import type { RecordLike } from './qa03-fixture.js';

const profile = process.env.QA07_PROFILE ?? 'quick';
test(
  'QA07 paced load, historical backfill, burst, pause recovery, scoped replay and command reliability',
  async () => {
    const plan = buildLoadPlan(profile);
    const f = await createQa03Fixture('QA07');
    let metrics: Record<string, unknown> | undefined;
    try {
      const actor = {
        actorId: f.prefix,
        tokenUse: 'access' as const,
        username: f.prefix,
        actorType: 'platform' as const,
        roles: ['PlatformSuperAdmin' as const],
        customerId: null,
        authenticatedAt: f.now.toISOString(),
      };
      const consoleApi = createAdminDeviceConsoleHandlers({
        client: f.prisma,
        now: () => f.now,
        storage: {
          put: async () => {
            throw new Error('Unexpected export');
          },
        },
        urlSigner: {
          sign: () => {
            throw new Error('Unexpected signing');
          },
        },
      });
      const originals = new Map<string, RecordLike>();
      const expected: { type: string; deviceId: string; ts: string; value: number }[] = [];
      for (const m of plan.messages.filter((m) => !m.duplicate)) {
        const record = f.record(m.type, m.device),
          body = JSON.parse(record.body);
        body.meta.seq = m.seq;
        body.meta.id = `${f.prefix}-${m.type.toUpperCase()}-${m.device}-${m.seq}`;
        body.meta.ts = new Date(f.now.getTime() + m.occurred * 1000).toISOString();
        if (m.stage !== 'history') body.iotReceivedAt = Date.parse(body.meta.ts);
        if (m.type === 'telemetry') body.data.currentAmp = m.seq % 100;
        const { iotTopic: _t, iotType: _y, iotDeviceId: _d, iotPrincipal: _p, iotReceivedAt: _r, ...payload } = body;
        if (body.audit) body.audit.hash = computeAuditHash(payload);
        originals.set(m.id, { ...record, body: JSON.stringify(body) });
        expected.push({ type: m.type, deviceId: body.iotDeviceId, ts: body.meta.ts, value: body.data.currentAmp ?? 0 });
      }
      const queue: { m: PlannedMessage; enqueuedAt: number }[] = [],
        latencies: number[] = [];
      const pending = new Map<string, string>();
      let producing = true,
        pauseVerified = false,
        backlogAtResume = 0,
        partialRetries = 0,
        maxBacklog = 0,
        paused = false;
      let held: PlannedMessage | undefined;
      const hold = plan.messages.find(
        (m) => m.stage === 'burst' && m.device === 0 && !m.duplicate && m.occurred > plan.config.normalSeconds + 3,
      )!;
      const transient = plan.messages.find((m) => m.stage === 'history' && m.device === 1 && !m.duplicate)!;
      let failedOnce = false;
      const started = performance.now();
      const producer = (async () => {
        try {
          for (const m of plan.messages) {
            const wait = started + (m.due * 1000) / plan.config.timeScale - performance.now();
            if (wait > 0) await sleep(wait);
            queue.push({ m, enqueuedAt: performance.now() });
            maxBacklog = Math.max(maxBacklog, queue.length);
          }
        } finally {
          producing = false;
        }
      })();
      const running = new Map<number, number[]>();
      const consumer = (async () => {
        while (producing || queue.length) {
          const item = queue.shift();
          if (!item) {
            await sleep(1);
            continue;
          }
          const { m, enqueuedAt } = item;
          if (m.stage === 'burst' && !paused) {
            paused = true;
            const before = await f.prisma.ingestionReceipt.count();
            await sleep(200);
            assert.equal(
              await f.prisma.ingestionReceipt.count(),
              before,
              'paused worker makes no writes while producer continues',
            );
            backlogAtResume = queue.length;
            assert.isAbove(backlogAtResume, 0);
            pauseVerified = true;
          }
          if (m.id === hold.id) {
            held = m;
            pending.set(m.id, 'HELD_FOR_RECOVERY');
            continue;
          }
          const record = originals.get(m.id)!;
          if (m.id === transient.id && !failedOnce) {
            f.faults.ingestionId = JSON.parse(record.body).meta.id;
            failedOnce = true;
          }
          const result = await f.ingest({ Records: [record] });
          if (result.batchItemFailures.length) {
            assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: record.messageId }]);
            assert.equal(
              await f.prisma.ingestionReceipt.count({
                where: { deviceId: f.devices[m.device]!.deviceId, topicType: m.type, seq: m.seq },
              }),
              0,
            );
            pending.set(m.id, 'TRANSIENT_RETRY');
            partialRetries++;
            assert.deepEqual((await f.ingest({ Records: [record] })).batchItemFailures, []);
            pending.delete(m.id);
          }
          if (m.stage === 'normal' && m.type === 'telemetry' && !m.duplicate) {
            const values = running.get(m.device) ?? [];
            values.push(m.seq % 100);
            running.set(m.device, values);
            const response = await consoleApi.getDeviceConsole({
              requestId: m.id,
              headers: {},
              actor,
              params: { deviceId: f.devices[m.device]!.deviceId },
            });
            assert.equal(response.status, 200);
            const data = (response.body as any).data;
            assert.approximately(
              data.metrics.metrics.currentAmp.avg,
              values.reduce((a, b) => a + b, 0) / values.length,
              1e-8,
            );
            assert.equal(
              data.metrics.observedAt,
              new Date(Math.floor(f.now.getTime() / 3600000) * 3600000).toISOString(),
            );
            latencies.push(performance.now() - enqueuedAt);
          }
        }
      })();
      // Wait for both tasks, including cleanup on a failed consumer.
      const completed = await Promise.allSettled([producer, consumer]);
      for (const result of completed) if (result.status === 'rejected') throw result.reason;
      assert.ok(held);
      assert.equal(partialRetries, 1);
      assert.equal(pending.size, 1);
      const openGaps = await gapStatus(f.prisma, { deviceId: f.devices[0]!.deviceId, topicType: 'telemetry' });
      assert.isTrue(openGaps.some((g) => g.missingFromSeq <= hold.seq && g.missingToSeq >= hold.seq));
      assert.equal(await f.prisma.ingestionReceipt.count(), plan.uniqueTelemetry + plan.uniqueHeartbeat - 1);
      assert.deepEqual((await f.ingest({ Records: [originals.get(held.id)!] })).batchItemFailures, []);
      pending.delete(held.id);
      assert.equal(pending.size, 0);
      assert.equal(await f.prisma.ingestionGap.count({ where: { resolvedAt: null } }), 0);
      const gapRows = await f.prisma.ingestionGap.count();
      assert.isAbove(gapRows, 0);
      const receipts = await f.prisma.ingestionReceipt.findMany();
      assert.equal(receipts.length, plan.uniqueTelemetry + plan.uniqueHeartbeat);
      assert.equal(new Set(receipts.map((r) => `${r.deviceId}/${r.topicType}/${r.seq}`)).size, receipts.length);
      assert.equal(f.quarantine.length, 0);
      const readAggregates = async () =>
        (await f.prisma.telemetryHourly.findMany()).map((r) => {
          const value = (r.metrics as any).currentAmp;
          assert.equal(value.count, r.sampleCount);
          return {
            key: `${r.deviceId}/${r.bucketStart.getTime()}`,
            sampleCount: r.sampleCount,
            avg: value.avg,
            min: value.min,
            max: value.max,
          };
        });
      const consistency = checkConsistency(expectedAggregates(expected), await readAggregates());
      f.faults.send = true;
      let sendRetries = 0;
      while (await f.prisma.outboxEvent.count({ where: { status: 'PENDING' } })) {
        const result = await f.publisher.publishPendingBatch();
        sendRetries += result.retried;
      }
      assert.equal(sendRetries, 1);
      assert.equal(f.archiveQueue.length, plan.uniqueTelemetry);
      f.faults.manifest = true;
      assert.isAbove((await f.archive({ Records: f.archiveQueue })).batchItemFailures.length, 0);
      assert.deepEqual((await f.archive({ Records: f.archiveQueue })).batchItemFailures, []);
      let archived = 0;
      const raw = new Map([...originals.values()].map((r) => [JSON.parse(r.body).meta.id, r.body]));
      for (const [key, bytes] of f.objects) {
        if (!key.endsWith('.json.gz')) continue;
        const manifest = JSON.parse(Buffer.from(f.objects.get(key.replace('.json.gz', '.manifest.json'))!).toString());
        assert.equal(manifest.sha256, sha(bytes));
        for (const line of gunzipSync(bytes).toString().trim().split('\n')) {
          const row = JSON.parse(line);
          assert.equal(row.rawBody, raw.get(row.messageId));
          archived++;
        }
      }
      assert.equal(archived, plan.uniqueTelemetry);
      const replayRecords: RecordLike[] = [];
      const replay = createReplayWorker({
        client: f.prisma,
        now: () => f.now,
        reader: {
          listKeys: async (prefix) => [...f.objects.keys()].filter((key) => key.startsWith(prefix)),
          getObject: async (key) => f.objects.get(key)!,
        },
        sink: createReplayIngressSink({
          client: f.prisma,
          partition: 'aws',
          region: 'ap-southeast-1',
          accountId: '123456789012',
          now: () => f.now,
          sender: {
            send: async (body) => {
              replayRecords.push({ messageId: `QA07-replay-${replayRecords.length}`, body: JSON.stringify(body) });
            },
          },
        }),
      });
      const from = new Date(f.now.getTime() - 86400000),
        to = new Date(from.getTime() + plan.config.historyWindowSeconds * 1000 - 1);
      const scope = {
        customerId: f.customerId,
        deviceId: f.devices[0]!.deviceId,
        topicType: 'telemetry',
        from: from.toISOString(),
        to: to.toISOString(),
        seqFrom: plan.config.normalSeconds / 10 + 1,
        seqTo: plan.config.normalSeconds / 10 + plan.config.historyWindowSeconds / 10,
      };
      const job = await f.prisma.replayJob.create({ data: { requestedBy: f.prefix, scope, status: 'PENDING' } });
      const result = await replay.executeJob(job.id);
      assert.equal(result.status, 'COMPLETED');
      assert.equal(result.summary?.sent, plan.config.historyWindowSeconds / 10);
      assert.equal(result.summary?.failed, 0);
      assert.isAbove(result.summary!.skipped, 0);
      for (const r of replayRecords) {
        const body = JSON.parse(r.body);
        assert.equal(body.iotDeviceId, scope.deviceId);
        assert.isAtLeast(Date.parse(body.meta.ts), from.getTime());
        assert.isAtMost(Date.parse(body.meta.ts), to.getTime());
        assert.isAtLeast(body.meta.seq, scope.seqFrom);
        assert.isAtMost(body.meta.seq, scope.seqTo);
      }
      const before = await readAggregates(),
        outboxBefore = await f.prisma.outboxEvent.count();
      assert.deepEqual((await f.ingest({ Records: replayRecords })).batchItemFailures, []);
      assert.deepEqual(await readAggregates(), before);
      assert.equal(await f.prisma.outboxEvent.count(), outboxBefore);
      assert.equal((await replay.executeJob(job.id)).status, 'ALREADY_DONE');
      const commandLatencies: number[] = [],
        published: string[] = [];
      for (const d of f.devices) {
        await f.prisma.deviceCommand.update({ where: { id: d.commandId }, data: { status: 'AUTHORIZED' } });
        const online = await consoleApi.getDeviceConsole({
          requestId: d.commandId,
          headers: {},
          actor,
          params: { deviceId: d.deviceId },
        });
        assert.equal(online.status, 200);
        assert.equal((online.body as any).data.device.connectivity, 'ONLINE');
        const enqueuedAt = performance.now();
        const mqtt = {
          publish: async ({ payload }: { payload: string }) => {
            published.push(JSON.parse(payload).meta.id);
            return { providerMessageId: f.prefix };
          },
        };
        assert.equal(
          (await publishCommand({ client: f.prisma, now: () => f.now, mqtt }, d.commandId)).status,
          'PUBLISHED',
        );
        commandLatencies.push(performance.now() - enqueuedAt);
        assert.equal(
          (await publishCommand({ client: f.prisma, now: () => f.now, mqtt }, d.commandId)).status,
          'REPLAYED_PUBLISHED',
        );
      }
      assert.equal(new Set(published).size, 10);
      assert.equal(published.length, 10);
      const late = f.devices[0]!;
      await f.prisma.deviceCommand.update({ where: { id: late.commandId }, data: { expiresAt: f.now } });
      assert.deepEqual((await evaluateCommandTimeouts({ client: f.prisma, now: () => f.now })).timedOut, [
        late.commandId,
      ]);
      assert.deepEqual((await evaluateCommandTimeouts({ client: f.prisma, now: () => f.now })).timedOut, []);
      assert.deepEqual((await f.ingest({ Records: [f.record('ack')] })).batchItemFailures, []);
      assert.equal(
        (await f.prisma.deviceCommand.findUniqueOrThrow({ where: { id: late.commandId } })).status,
        'TIMED_OUT',
      );
      assert.equal(await f.prisma.commandAck.count({ where: { commandId: late.commandId } }), 1);
      const telemetryLatency = { ...latencySummary(latencies), valuesMs: latencies },
        commandLatency = { ...latencySummary(commandLatencies), valuesMs: commandLatencies };
      assert.isAtMost(telemetryLatency.p95Ms, 5000);
      assert.isAtMost(commandLatency.p95Ms, 3000);
      metrics = {
        profile,
        config: plan.config,
        deviceCount: 10,
        telemetrySeconds: 10,
        heartbeatSeconds: 60,
        historyHours: 24,
        historyExecutedSeconds: plan.historyExecutedSeconds,
        uniqueTelemetry: plan.uniqueTelemetry,
        uniqueHeartbeat: plan.uniqueHeartbeat,
        duplicatesInjected: plan.duplicates,
        reorderedInjected: plan.reordered,
        burstMultiplier: 30,
        receipts: receipts.length,
        consistency,
        archived,
        archiveHashesVerified: archived,
        quarantined: 0,
        telemetryLatency,
        commandLatency,
        schedulerElapsedMs: performance.now() - started,
        maxBacklog,
        pauseVerified,
        backlogAtResume,
        partialRetries,
        sendRetries,
        manifestRetry: true,
        gapRows,
        gapObserved: true,
        unresolvedGaps: 0,
        untrackedMissing: 0,
        pendingAfterRecovery: 0,
        replaySent: replayRecords.length,
        replaySkipped: result.summary!.skipped,
        replayFailed: 0,
        replayIdempotent: true,
        commandPublished: 10,
        duplicateCommandPublishes: 0,
        timeoutAudit: await f.prisma.auditLog.count({ where: { action: 'command.timeout', objectId: late.commandId } }),
        lateAckPreserved: true,
      };
    } finally {
      await f.cleanup();
    }
    if (metrics && process.env.QA07_TRACE)
      appendFileSync(
        process.env.QA07_TRACE,
        JSON.stringify({ task: 'QA-07', status: 'PASS', prefix: f.prefix, cleanup: 'PASS', ...metrics }) + '\n',
      );
  },
  profile === 'full' ? 1800000 : 180000,
);

test('QA07 production timestamp boundaries quarantine old or future Telemetry without weakening other topics', async () => {
  const f = await createQa03Fixture('QA07');
  try {
    const make = (type: 'telemetry' | 'heartbeat', ageMs: number) => {
      const record = f.record(type),
        body = JSON.parse(record.body);
      body.meta.ts = new Date(f.now.getTime() - ageMs).toISOString();
      const { iotTopic: _t, iotType: _y, iotDeviceId: _d, iotPrincipal: _p, iotReceivedAt: _r, ...payload } = body;
      if (body.audit) body.audit.hash = computeAuditHash(payload);
      return { ...record, body: JSON.stringify(body) };
    };
    const legal = [make('telemetry', 86400000), make('telemetry', -300000)];
    assert.deepEqual((await f.ingest({ Records: legal })).batchItemFailures, []);
    assert.equal(await f.prisma.ingestionReceipt.count(), 2);
    const rejected = [make('telemetry', 86400001), make('telemetry', -300001), make('heartbeat', 300001)];
    assert.deepEqual((await f.ingest({ Records: rejected })).batchItemFailures, []);
    assert.equal(await f.prisma.ingestionReceipt.count(), 2);
    assert.equal(await f.prisma.outboxEvent.count(), 2);
    assert.deepEqual(
      f.quarantine.map((r) => r.errorType),
      ['CLOCK_SKEW', 'CLOCK_SKEW', 'CLOCK_SKEW'],
    );
    assert.deepEqual(
      f.quarantine.map((r) => r.rawBody),
      rejected.map((r) => r.body),
    );
    const badHash = JSON.parse(make('telemetry', 86400000).body);
    badHash.audit.hash = '0'.repeat(64);
    assert.deepEqual(
      (await f.ingest({ Records: [{ messageId: 'QA07-bad-hash', body: JSON.stringify(badHash) }] })).batchItemFailures,
      [],
    );
    assert.equal(f.quarantine[3]!.errorType, 'AUDIT_HASH_MISMATCH');
    assert.equal(await f.prisma.ingestionReceipt.count(), 2);
  } finally {
    await f.cleanup();
  }
}, 60000);
