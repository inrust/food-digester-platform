import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { publishScheduled } from './qa09-publish-scheduler.mjs';
import { connectAsync } from 'mqtt';
import { createHash } from 'node:crypto';
import { buildLoadPlan } from './reliability-plan.mjs';
import { computeAuditHash } from '../contracts/mqtt/payload-normalization.ts';
import { canonical } from './qa09-archive-probe.mjs';
import { readOwnArchives } from './qa09-archive-reader.mjs';
const sha = (v) => createHash('sha256').update(v).digest('hex');
export async function runMqttQuickTarget(ctx, db, check, output) {
  const plan = buildLoadPlan('quick'),
    clients = [],
    ledger = [],
    payloads = new Map();
  // New MQTT sessions use real per-device certificates already held only in memory.
  try {
    for (const [id, k] of ctx.held) {
      await k.client.endAsync(true).catch(() => {});
      const client = await connectAsync(`mqtts://${k.endpoint}:8883`, {
        clientId: id,
        cert: k.cert,
        key: k.key,
        rejectUnauthorized: true,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 15000,
      });
      client.on('error', () => {});
      clients.push(client);
    }
    const origin = performance.now();
    const ledgerFile = output + '.mqtt-publisher.ndjson';
    writeFileSync(ledgerFile, '');
    const persist = (entry) => appendFileSync(ledgerFile, JSON.stringify(entry) + '\n');
    let disconnected = false,
      historyReconnect;
    await publishScheduled(plan.messages, async (m) => {
      const id = ctx.receipt.devices[m.device],
        k = ctx.held.get(id);
      if (m.stage === 'history' && !disconnected) {
        disconnected = true;
        historyReconnect = (async () => {
          await clients[0].endAsync(true);
          clients[0] = await connectAsync(`mqtts://${ctx.held.get(ctx.receipt.devices[0]).endpoint}:8883`, {
            clientId: ctx.receipt.devices[0],
            cert: ctx.held.get(ctx.receipt.devices[0]).cert,
            key: ctx.held.get(ctx.receipt.devices[0]).key,
            rejectUnauthorized: true,
            protocolVersion: 4,
            clean: true,
            reconnectPeriod: 0,
            connectTimeout: 15000,
          });
          clients[0].on('error', () => {});
        })();
      }
      if (m.stage === 'history') await historyReconnect;
      let raw = payloads.get(m.id);
      if (!raw) {
        const payload = k.sim.payload(m.type);
        payload.meta.seq = (m.type === 'telemetry' ? 2 : 1) + m.seq;
        // Keep the oldest delivered sample inside the strict 24-hour boundary by a declared five-second margin.
        payload.meta.ts = new Date(Date.now() + (m.stage === 'history' ? (m.occurred + 5) * 1000 : 0)).toISOString();
        if (payload.audit) payload.audit.hash = computeAuditHash(payload);
        raw = JSON.stringify(payload);
        payloads.set(m.id, raw);
        ledger.push({
          deviceId: id,
          type: m.type,
          seq: payload.meta.seq,
          messageId: payload.meta.id,
          bodySha256: sha(raw),
          payloadSha256: sha(canonical(payload)),
          stage: m.stage,
          reordered: m.reordered,
          occurredAt: payload.meta.ts,
        });
      }
      const proof = ledger.find((row) => row.messageId === JSON.parse(raw).meta.id);
      persist({
        event: 'publish-attempt',
        ...proof,
        plannedDueSeconds: m.due,
        startedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - origin),
      });
      let timeout;
      try {
        await Promise.race([
          clients[m.device].publishAsync(`bnx/device/${id}/${m.type}`, raw, { qos: 1 }),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Error('LOAD_PUBACK_TIMEOUT')), 15000);
          }),
        ]);
        persist({
          event: 'puback',
          messageId: proof.messageId,
          bodySha256: proof.bodySha256,
          acknowledgedAt: new Date().toISOString(),
        });
      } finally {
        clearTimeout(timeout);
      }
    });
    const burst = ledger.filter((row) => row.stage === 'burst' && row.type === 'telemetry');
    const burstSeconds =
      (Math.max(...burst.map((row) => Date.parse(row.occurredAt))) -
        Math.min(...burst.map((row) => Date.parse(row.occurredAt)))) /
      1000;
    check('quick-mqtt-real-burst-window', burst.length === 300 && burstSeconds <= 11, {
      count: burst.length,
      elapsedSeconds: burstSeconds,
      nominalSeconds: 10,
      schedulingToleranceSeconds: 1,
    });
    check('quick-mqtt-published', ledger.length === plan.uniqueTelemetry + plan.uniqueHeartbeat, {
      uniqueTelemetry: plan.uniqueTelemetry,
      uniqueHeartbeat: plan.uniqueHeartbeat,
      duplicates: plan.duplicates,
      reordered: plan.reordered,
      elapsedMs: Math.round(performance.now() - origin),
      oldestHistoryAgeSeconds: 86395,
      fullProfileExecuted: false,
    });
    const observed = await db('observe');
    check(
      'quick-mqtt-no-extra-business-samples',
      observed.telemetrySamples.length === 10 && observed.telemetrySamples.every((t) => t.samples === '92'),
    );
    check(
      'quick-mqtt-ingestion-processed',
      observed.receipts.length === 950 && observed.receipts.every((t) => t.result === 'PROCESSED'),
    );
    const archives = await readOwnArchives(
      { ...ctx.receipt, published: [...ctx.receipt.published, ...ledger], archiveProfile: 'QA07_QUICK_REAL_MQTT' },
      observed,
      output + '.mqtt-archives.json',
    );
    check('quick-mqtt-archives-consistent', archives.gate === 'PASS' && archives.result.archivedMessages === 920, {
      archivedMessages: archives.result.archivedMessages,
    });
    // Full own-prefix discovery in parent finally includes every new object and version.
    ctx.receipt.archiveKeys = archives.result.archiveKeys;
    ctx.receipt.batchArchiveCleanup = true;
    return {
      profile: 'QA07_QUICK_REAL_MQTT',
      plan: {
        normalSeconds: 120,
        historyExecutedSeconds: 480,
        historyHours: 24,
        burstSeconds: 10,
        burstMultiplier: 30,
      },
      published: ledger,
      publisherLedger: ledgerFile,
      publisherLedgerSha256: sha(readFileSync(ledgerFile)),
      archiveReceipt: output + '.mqtt-archives.json',
      fullProfileExecuted: false,
    };
  } finally {
    for (const c of clients) await c.endAsync(true).catch(() => {});
    payloads.clear();
  }
}
