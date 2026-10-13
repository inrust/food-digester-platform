import { createHash } from 'node:crypto';
import { projectDataPathLog } from './qa09-data-path-evidence.mjs';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function replayGate(job, expected) {
  const s = job?.resultSummary;
  return job?.status === 'COMPLETED' &&
    job.completedAt &&
    Object.keys(job.scope ?? {}).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => job.scope[key] === value) &&
    s?.sent === 1 &&
    s.scannedObjects > 0 &&
    s.scannedLines > 0 &&
    ['failed', 'failedObjects', 'failedLines', 'sendFailures'].every((k) => s[k] === 0)
    ? 'PASS_NONEMPTY_EXACT_SCOPE_REPLAY'
    : 'NO_RECEIPT';
}
export function exactDuplicateGate(rows, expected) {
  if (!expected?.sqsMessageId || !expected?.messageId || !expected?.deviceId || !expected?.receiptId)
    return 'NOT_RUN_NO_SUBMISSION';
  const matches = (r) => ['sqsMessageId', 'messageId', 'deviceId', 'receiptId'].every((k) => r[k] === expected[k]);
  const final = rows.find(
    (r) =>
      matches(r) &&
      r.event === 'ingestion.record.completed' &&
      r.disposition === 'PROCESSED' &&
      r.receiptOutcome === 'DUPLICATE_SKIPPED' &&
      r.lambdaRequestId,
  );
  return final &&
    rows.some(
      (r) =>
        matches(r) &&
        r.event === 'ingestion.receipt.completed' &&
        r.receiptOutcome === 'DUPLICATE_SKIPPED' &&
        r.commitScope === 'ROOT_TRANSACTION_COMPLETED' &&
        r.lambdaRequestId === final.lambdaRequestId,
    )
    ? 'PASS_EXACT_DUPLICATE_CONSUMPTION'
    : 'NO_RECEIPT';
}
export function dedupGate(before, after) {
  const tables = ['ingestion_receipts', 'telemetry_hourly', 'telemetry_daily', 'outbox_events'];
  const valid = (r) =>
    r?.readOnly === true &&
    r.fingerprints?.length === tables.length &&
    tables.every(
      (t) =>
        r.fingerprints.filter(
          (f) => f.table === t && /^[a-f0-9]{32}$/.test(f.digest) && /^\d+$/.test(f.count) && Number(f.count) > 0,
        ).length === 1,
    ) &&
    r.receipts?.length === 30 &&
    r.receipts.every((x) => x.result === 'PROCESSED');
  return valid(before) &&
    valid(after) &&
    JSON.stringify(before.fingerprints) === JSON.stringify(after.fingerprints) &&
    JSON.stringify(before.receipts) === JSON.stringify(after.receipts) &&
    JSON.stringify(before.originalFingerprints) === JSON.stringify(after.originalFingerprints)
    ? 'PASS_NO_RECEIPT_AGGREGATE_OR_ARCHIVE_DUPLICATION'
    : 'NO_RECEIPT';
}
/** Read-only, small pages, one global budget. No mutation retries or queue reads. */
export async function collectExactConsumption(
  expected,
  { read, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), budgetMs = 90000 } = {},
) {
  if (
    !/^qa09-[a-f0-9]{16}-(0[1-9]|10)$/.test(expected.deviceId ?? '') ||
    !(
      /^[a-zA-Z0-9-]{1,128}$/.test(expected.sqsMessageId ?? '') ||
      (expected.sqsMessageId === undefined &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(expected.messageId ?? '') &&
        expected.receiptId)
    ) ||
    !Number.isFinite(expected.startMs) ||
    !Number.isFinite(expected.endMs) ||
    expected.endMs < expected.startMs ||
    expected.endMs - expected.startMs > 600000 ||
    !Number.isInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > 90000
  )
    throw Error('EXACT_BOUNDED_CONSUMER_SCOPE_REQUIRED');
  const started = now(),
    rows = [],
    reads = [];
  let failure;
  for (let round = 0; round < 6 && now() - started < budgetMs; round++) {
    let token;
    const tokens = new Set();
    for (let page = 0; page < 8; page++) {
      const remaining = budgetMs - (now() - started);
      if (remaining <= 0) {
        failure = 'TOTAL_READ_DEADLINE';
        break;
      }
      const args = [
        'logs',
        'filter-log-events',
        '--log-group-name',
        '/aws/lambda/fdp-test-ingestion',
        '--start-time',
        String(expected.startMs),
        '--end-time',
        String(expected.endMs),
        '--filter-pattern',
        `{ $.${expected.sqsMessageId ? 'sqsMessageId' : 'messageId'} = "${expected.sqsMessageId ?? expected.messageId}" }`,
        '--limit',
        '100',
        '--no-paginate',
      ];
      if (token) args.push('--next-token', token);
      let response;
      try {
        response = await read(args, Math.min(10000, remaining));
      } catch (e) {
        failure = /^[A-Za-z0-9_:-]{1,100}$/.test(e.code ?? '') ? e.code : 'LOG_READ_FAILED';
        break;
      }
      if (now() - started > budgetMs) {
        failure = 'TOTAL_READ_DEADLINE';
        break;
      }
      reads.push({ round, page, eventCount: response.events?.length ?? 0 });
      if ((response.events?.length ?? 0) > 100) {
        failure = 'LOG_PAGE_SIZE_EXCEEDED';
        break;
      }
      for (const e of response.events ?? []) {
        const row = projectDataPathLog(e.message);
        if (
          row &&
          (expected.sqsMessageId ? row.sqsMessageId === expected.sqsMessageId : row.messageId === expected.messageId) &&
          e.timestamp >= expected.startMs &&
          e.timestamp <= expected.endMs
        )
          rows.push({ ...row, observedAtMs: e.timestamp });
      }
      const candidates = expected.sqsMessageId
        ? [expected.sqsMessageId]
        : [...new Set(rows.map((r) => r.sqsMessageId).filter(Boolean))];
      const matched = candidates.filter((sqsMessageId) =>
        exactDuplicateGate(rows, { ...expected, sqsMessageId }).startsWith('PASS_'),
      );
      if (matched.length)
        return { gate: 'PASS_EXACT_DUPLICATE_CONSUMPTION', matchedSqsMessageIds: matched, rows, reads };
      if (!response.nextToken) break;
      if (tokens.has(response.nextToken)) {
        failure = 'REPEATED_LOG_TOKEN';
        break;
      }
      tokens.add(response.nextToken);
      token = response.nextToken;
      if (page === 7) failure = 'LOG_PAGE_LIMIT';
    }
    if (failure) break;
    const remaining = budgetMs - (now() - started);
    if (round < 5 && remaining > 0) await sleep(Math.min(10000, remaining));
  }
  return { gate: 'NO_RECEIPT', rows, reads, failure: failure ?? 'BOUNDED_CONSUMER_NOT_OBSERVED' };
}
export async function submitOnce(send, persist, input) {
  const r = { gate: 'ATTEMPTING', attemptedAt: new Date().toISOString(), retryAllowed: false };
  persist(r); // Durable uncertainty record precedes the only mutation attempt.
  try {
    const sent = await send(input);
    if (!sent.MessageId) {
      r.gate = 'UNKNOWN_SUBMISSION_NO_RETRY';
    } else
      Object.assign(r, {
        gate: 'SUBMITTED_CONSUMPTION_NOT_PROVEN',
        sqsMessageId: sent.MessageId,
        requestId: sent.$metadata?.requestId,
      });
  } catch (e) {
    const denied = /AccessDenied|KmsAccessDenied/.test(e.name ?? '') || /AccessDenied/.test(e.Code ?? '');
    Object.assign(r, {
      gate: denied ? 'BLOCKED_PERMISSION_NO_RETRY' : 'UNKNOWN_SUBMISSION_NO_RETRY',
      errorName: /^[A-Za-z0-9_-]{1,100}$/.test(e.name ?? '') ? e.name : 'Error',
    });
  }
  persist(r);
  return r;
}
/** Replace only the exact own device session before a never-attempted telemetry sequence. */
export async function refreshOwnTelemetrySession({ id, k, receipt, clients, connectAsync }) {
  if (
    !/^qa09-[a-f0-9]{16}$/.test(receipt.prefix) ||
    !receipt.devices?.includes(id) ||
    !new RegExp(`^${receipt.prefix}-(0[1-9]|10)$`).test(id) ||
    !/^[a-z0-9-]+\.iot\.ap-southeast-1\.amazonaws\.com$/.test(k.endpoint ?? '') ||
    !k.cert ||
    !k.key
  )
    throw Error('OWN_TELEMETRY_SESSION_REQUIRED');
  let timer;
  try {
    await Promise.race([
      k.client.endAsync(true),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('MQTT_CLOSE_TIMEOUT')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  k.client = client;
  if (!client.connected) throw Error('FRESH_TELEMETRY_SESSION_NOT_CONNECTED');
  receipt.checks.push({
    id: id + ':fresh-telemetry-session',
    result: 'PASS',
    automaticReconnect: false,
    publicationRetry: false,
  });
  receipt.batchArchiveCleanup = true;
}
/** Cleanup never competes with an unknown/running owned write; failed original operations stay failed. */
export async function finishOwnReplayCleanup({ baseline, terminal, postAttempted, hold }, db) {
  if (!baseline) return { gate: 'NOT_STARTED' };
  if (hold || (postAttempted && !terminal)) return { gate: 'BLOCKED_UNKNOWN_OR_RUNNING_REPLAY' };
  try {
    await db('business-cleanup', { businessBaseline: baseline });
    await db('business-audit', { businessBaseline: baseline });
    return { gate: 'PASS' };
  } catch {
    return { gate: 'FAIL_OR_UNKNOWN_NO_MUTATION_RETRY' };
  }
}
