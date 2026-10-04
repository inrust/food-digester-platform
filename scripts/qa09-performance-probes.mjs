import { redeliverOwnProcessedTelemetry } from './qa09-own-queue-redelivery.mjs';
import { connectAsync } from 'mqtt';
import { createHash } from 'node:crypto';
import { computeAuditHash } from '../contracts/mqtt/payload-normalization.ts';
import { canonical } from './qa09-archive-probe.mjs';
import { mtlsPost } from './run-qa09-ten-device-acceptance.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export function p95(values) {
  if (!values.length || values.some((x) => !Number.isFinite(x) || x < 0)) throw Error('INVALID_LATENCY_SAMPLE');
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}
export function completeP95(samples, field) {
  return samples.length === 20 &&
    samples.every((x) => x[field] === true && Number.isFinite(x.latencyMs) && x.latencyMs >= 0)
    ? p95(samples.map((x) => x.latencyMs))
    : null;
}
export async function runPerformanceProbes(
  ctx,
  api,
  record,
  output,
  { afterActivation, commandOnly = false, lifecycleProbes = true } = {},
) {
  const id = ctx.receipt.devices[0],
    key = ctx.held.get(id),
    prefix = ctx.receipt.prefix;
  const client = await connectAsync(`mqtts://${key.endpoint}:8883`, {
    clientId: id,
    cert: key.cert,
    key: key.key,
    rejectUnauthorized: true,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 15000,
  });
  client.on('error', () => {});
  let heartbeatSeq = 20000;
  const heartbeatTasks = [];
  const heartbeatFailures = [];
  const heartbeat = () => {
    const payload = key.sim.payload('heartbeat');
    payload.meta.seq = heartbeatSeq++;
    const task = client
      .publishAsync(`bnx/device/${id}/heartbeat`, JSON.stringify(payload), { qos: 1 })
      .catch((e) => heartbeatFailures.push(e.name));
    heartbeatTasks.push(task);
    return task;
  };
  await heartbeat();
  const heartbeatTimer = setInterval(heartbeat, 30000);

  const result = {
    scope: commandOnly ? 'REAL_ONLINE_COMMAND_ONLY' : 'REAL_API_VISIBILITY_AND_ONLINE_COMMAND',
    telemetryGate: commandOnly ? 'NOT_RUN_COMMAND_ONLY' : 'RUNNING',
    telemetry: [],
    commands: [],
    lifecycle: [],
    lifecycleGate: lifecycleProbes
      ? 'INDEPENDENT_LIFECYCLE_ASSERTIONS_REQUIRED'
      : 'NOT_RUN_NO_NATURAL_ACTIVE_PRECONDITION',
    fullQa09Accepted: false,
  };
  const put = (name, pass, data) => record(name, pass, data);
  try {
    let redeliveryRaw;
    // Markers are unique increasing maxima in the current UTC hourly bucket, verified absent before publish.
    for (let i = 0; i < (commandOnly ? 0 : 20); i++) {
      const before = await api(
        'slo-before-' + i,
        'PlatformSuperAdmin',
        'GET',
        `/api/v1/admin/devices/${id}/console`,
        200,
      );
      const previous = before.data.metrics.metrics.feedingWeightKg?.max ?? 25;
      const marker = Number((previous + 1 + i / 1000).toFixed(3));
      const payload = key.sim.payload('telemetry');
      payload.meta.seq = 10000 + i;
      payload.data.feedingWeightKg = marker;
      payload.audit.hash = computeAuditHash(payload);
      const raw = JSON.stringify(payload),
        start = performance.now();
      await client.publishAsync(`bnx/device/${id}/telemetry`, raw, { qos: 1 });
      ctx.receipt.published.push({
        deviceId: id,
        type: 'telemetry',
        seq: payload.meta.seq,
        messageId: payload.meta.id,
        bodySha256: createHash('sha256').update(raw).digest('hex'),
        payloadSha256: createHash('sha256').update(canonical(payload)).digest('hex'),
      });
      let visible = false,
        polls = 0;
      while (performance.now() - start < 30000) {
        const response = await api(
          'slo-poll-' + i + '-' + polls++,
          'PlatformSuperAdmin',
          'GET',
          `/api/v1/admin/devices/${id}/console`,
          200,
        );
        if (Math.abs((response.data.metrics.metrics.feedingWeightKg?.max ?? -1) - marker) < 1e-9) {
          visible = true;
          break;
        }
        await pause(250);
      }
      if (!redeliveryRaw && visible) redeliveryRaw = raw;
      result.telemetry.push({
        messageId: payload.meta.id,
        marker,
        visible,
        latencyMs: Math.round(performance.now() - start),
        polls,
      });
    }
    if (redeliveryRaw)
      result.queueRedelivery = await redeliverOwnProcessedTelemetry(
        ctx,
        redeliveryRaw,
        output + '.performance-queue-redelivery.json',
      );
    const license = (
      await api('command-slo-license-create', 'PlatformOperator', 'POST', '/api/v1/admin/licenses', 201, {
        deviceId: id,
        validFrom: new Date(Date.now() - 60000).toISOString(),
        validTo: new Date(Date.now() + 86400000 * 60).toISOString(),
        entitlements: ['REMOTE_CONTROL'],
        reason: prefix,
      })
    ).data;
    let version = license.version;
    for (const action of ['issue', 'activate']) {
      const response = await api(
        'command-slo-license-' + action,
        'PlatformOperator',
        'POST',
        '/api/v1/admin/licenses/' + license.licenseId + '/' + action,
        200,
        undefined,
        { 'If-Match': String(version) },
      );
      version = response.data.version;
    }
    if (afterActivation) await afterActivation();
    const pending = new Map(),
      arrivals = new Map(),
      ackTasks = [];
    const listener = (topic, bytes) => {
      if (topic !== `bnx/device/${id}/cmd`) return;
      let msg;
      try {
        msg = JSON.parse(bytes);
      } catch {
        return;
      }
      if (!pending.has(msg.meta?.id)) return;
      if (!arrivals.has(msg.meta.id))
        arrivals.set(msg.meta.id, Math.round(performance.now() - pending.get(msg.meta.id)));
      const ack = key.sim.payload('ack', {
        objectType: 'COMMAND',
        commandId: msg.meta.id,
        command: msg.data.command,
        result: 'SUCCESS',
        executeTimeMs: 20,
      });
      ack.meta.seq = 10000 + ackTasks.length;
      ackTasks.push(
        client.publishAsync(`bnx/device/${id}/ack`, JSON.stringify(ack), { qos: 1 }).catch(() => {
          result.ackFailure = true;
        }),
      );
    };
    client.on('message', listener);
    await client.subscribeAsync(`bnx/device/${id}/cmd`, { qos: 1 });
    for (let i = 0; i < 20; i++) {
      const commandId = `${prefix.toUpperCase()}-CMD-${i}`;
      pending.set(commandId, performance.now());
      await api('command-slo-create-' + i, 'PlatformSuperAdmin', 'POST', `/api/v1/admin/devices/${id}/commands`, 201, {
        commandId,
        command: 'FORCE_SYNC',
        timeoutSec: 180,
        remarks: prefix,
      });
    }
    const deadline = performance.now() + 95000;
    while (arrivals.size < 20 && performance.now() < deadline) await pause(250);
    await Promise.all(ackTasks);
    client.off('message', listener);
    for (const [commandId, start] of pending)
      result.commands.push({
        commandId,
        received: arrivals.has(commandId),
        latencyMs: arrivals.get(commandId) ?? null,
        elapsedAtEndMs: Math.round(performance.now() - start),
      });
    result.telemetryP95Ms = completeP95(result.telemetry, 'visible');
    if (!commandOnly)
      result.telemetryGate = result.telemetryP95Ms !== null && result.telemetryP95Ms <= 5000 ? 'PASS' : 'FAIL';
    const received = result.commands.filter((x) => x.received);
    result.commandP95Ms = received.length === 20 ? p95(received.map((x) => x.latencyMs)) : null;
    result.commandGate = result.commandP95Ms !== null && result.commandP95Ms <= 3000 ? 'PASS' : 'FAIL';
    if (!commandOnly)
      put('telemetry-api-visible-p95', result.telemetryP95Ms !== null && result.telemetryP95Ms <= 5000, {
        samples: 20,
        p95Ms: result.telemetryP95Ms,
        limitMs: 5000,
        pollResolutionMs: 250,
      });
    put('online-command-publish-p95', result.commandP95Ms !== null && result.commandP95Ms <= 3000, {
      samples: 20,
      received: received.length,
      p95Ms: result.commandP95Ms,
      limitMs: 3000,
      clock: 'SAME_CLIENT_MONOTONIC_API_START_TO_BROKER_CALLBACK',
    });
    if (commandOnly || !lifecycleProbes) return result;
    const suspended = await api(
      'lifecycle-suspend',
      'PlatformOperator',
      'POST',
      `/api/v1/admin/devices/${id}/suspend`,
      200,
      { reason: prefix },
    );
    put('lifecycle-suspended', suspended.data.lifecycleStatus === 'Suspended');
    const repeat = await api(
      'lifecycle-suspend-replay',
      'PlatformOperator',
      'POST',
      `/api/v1/admin/devices/${id}/suspend`,
      200,
      { reason: prefix },
    );
    put('lifecycle-suspend-idempotent', repeat.data.replayed === true);
    const active = await api(
      'lifecycle-reactivate',
      'PlatformOperator',
      'POST',
      `/api/v1/admin/devices/${id}/reactivate`,
      200,
      { reason: prefix, issueResolved: true },
    );
    put('lifecycle-reactivated', active.data.lifecycleStatus === 'Active');
    clearInterval(heartbeatTimer);
    await Promise.all(heartbeatTasks);
    const sync = await mtlsPost(key.cert, key.key);
    put('post-update-real-mtls-sync', sync.status === 200, {
      status: sync.status,
      requestId: sync.requestId,
      topLevelKeys: Object.keys(sync.body ?? {}),
    });
    const retired = await api(
      'lifecycle-retire',
      'PlatformSuperAdmin',
      'POST',
      `/api/v1/admin/devices/${id}/retire`,
      200,
      { reason: prefix, confirm: true },
    );
    result.lifecycle.push({ action: 'retire', data: retired.data });
    const retiredSync = await mtlsPost(key.cert, key.key);
    put('retired-pending-confirmation-sync', retiredSync.status === 200, { status: retiredSync.status });
    await api('retired-reactivate-denied', 'PlatformOperator', 'POST', `/api/v1/admin/devices/${id}/reactivate`, 409, {
      reason: prefix,
      issueResolved: true,
    });

    await api(
      'lifecycle-force-complete',
      'PlatformSuperAdmin',
      'POST',
      `/api/v1/admin/devices/${id}/retire/complete`,
      200,
      { reason: prefix },
    );
    const revokedSync = await mtlsPost(key.cert, key.key);
    put('revoked-device-real-mtls-sync-denied', [401, 403].includes(revokedSync.status), {
      status: revokedSync.status,
      requestId: revokedSync.requestId,
    });
  } finally {
    clearInterval(heartbeatTimer);
    await Promise.all(heartbeatTasks);
    result.keepalive = { intervalMs: 30000, published: heartbeatTasks.length, failures: heartbeatFailures };
    await client.endAsync(true).catch(() => {});
    const { writeFileSync } = await import('node:fs');
    writeFileSync(output + '.slo.json', JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}
