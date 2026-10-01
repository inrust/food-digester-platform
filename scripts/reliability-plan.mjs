export const PROFILES = {
  quick: { normalSeconds: 120, historyWindowSeconds: 20, burstSeconds: 10, timeScale: 20 },
  full: { normalSeconds: 600, historyWindowSeconds: 3600, burstSeconds: 10, timeScale: 1000 },
};
export function buildLoadPlan(profile = 'quick') {
  const config = PROFILES[profile];
  if (!config) throw new Error('INVALID_LOAD_PROFILE');
  const messages = [],
    sequences = new Map();
  const add = (stage, type, device, due, occurred) => {
    const key = `${device}/${type}`,
      seq = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, seq);
    messages.push({ id: `${key}/${seq}`, stage, type, device, seq, due, occurred, duplicate: false, reordered: false });
  };
  for (let sec = 0; sec < config.normalSeconds; sec += 10)
    for (let d = 0; d < 10; d++) {
      add('normal', 'telemetry', d, sec, sec);
      if (sec % 60 === 0) add('normal', 'heartbeat', d, sec, sec);
    }
  let due = config.normalSeconds;
  // Quick mode executes the first 20 seconds in each of 24 historical hours.
  // Full mode executes every 10-second sample throughout all 24 hours.
  for (let hour = 0; hour < 24; hour++)
    for (let sec = 0; sec < config.historyWindowSeconds; sec += 10) {
      for (let d = 0; d < 10; d++) add('history', 'telemetry', d, due, -86400 + hour * 3600 + sec);
      due += 10;
    }
  const burstStart = due;
  for (let round = 0; round < config.burstSeconds * 3; round++)
    for (let d = 0; d < 10; d++) add('burst', 'telemetry', d, burstStart + round / 3, config.normalSeconds + round / 3);
  const telemetry = messages.filter((m) => m.type === 'telemetry');
  const reorderCount = Math.floor(telemetry.length * 0.02);
  for (let i = 0; i < reorderCount; i++) {
    const m = telemetry[i * 50 + 1];
    const next = telemetry.find((n) => n.device === m.device && n.stage === m.stage && n.seq === m.seq + 1);
    if (!next) throw new Error('INVALID_REORDER_SCHEDULE');
    m.due = next.due + 0.001;
    m.reordered = true;
  }
  const duplicates = Math.floor(telemetry.length * 0.05);
  for (let i = 0; i < duplicates; i++) {
    const m = telemetry[i * 20];
    messages.push({ ...m, due: m.due + 0.002, duplicate: true, reordered: false });
  }
  return {
    profile,
    config,
    deviceCount: 10,
    telemetrySeconds: 10,
    heartbeatSeconds: 60,
    historyHours: 24,
    historyExecutedSeconds: config.historyWindowSeconds * 24,
    burstMultiplier: 30,
    uniqueTelemetry: telemetry.length,
    uniqueHeartbeat: messages.filter((m) => m.type === 'heartbeat').length,
    duplicates,
    reordered: reorderCount,
    messages: messages.sort((a, b) => a.due - b.due || a.device - b.device),
  };
}
export function latencySummary(samples) {
  if (!samples.length || samples.some((v) => !Number.isFinite(v) || v < 0)) throw new Error('INVALID_LATENCY_SAMPLES');
  const values = [...samples].sort((a, b) => a - b);
  return { samples: values.length, p95Ms: values[Math.ceil(values.length * 0.95) - 1], maxMs: values.at(-1) };
}
// Independent expected aggregate: input fixture data, never production mergeMetrics.
export function expectedAggregates(records) {
  const buckets = new Map();
  for (const r of records) {
    if (r.type !== 'telemetry') continue;
    const key = `${r.deviceId}/${Math.floor(Date.parse(r.ts) / 3600000) * 3600000}`;
    const row = buckets.get(key) ?? { sampleCount: 0, values: [] };
    row.sampleCount++;
    row.values.push(r.value);
    buckets.set(key, row);
  }
  return [...buckets].map(([key, row]) => ({
    key,
    sampleCount: row.sampleCount,
    avg: row.values.reduce((a, b) => a + b, 0) / row.values.length,
    min: Math.min(...row.values),
    max: Math.max(...row.values),
  }));
}
export function checkConsistency(expected, actual) {
  if (expected.length !== actual.length || new Set(actual.map((r) => r.key)).size !== actual.length)
    throw new Error('AGGREGATE_BUCKET_MISMATCH');
  for (const e of expected) {
    const a = actual.find((r) => r.key === e.key);
    if (
      !a ||
      a.sampleCount !== e.sampleCount ||
      a.min !== e.min ||
      a.max !== e.max ||
      !Number.isFinite(a.avg) ||
      Math.abs(a.avg - e.avg) > 1e-8
    )
      throw new Error('AGGREGATE_VALUE_MISMATCH');
  }
  return {
    buckets: expected.length,
    samples: expected.reduce((n, r) => n + r.sampleCount, 0),
    duplicateBusinessRows: 0,
  };
}
