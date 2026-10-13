import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  replayGate,
  exactDuplicateGate,
  dedupGate,
  submitOnce,
  collectExactConsumption,
} from './qa09-reliability-closeout.mjs';
import { executeFixture } from './qa09-ten-device-db.mjs';
const prefix = 'qa09-1234567890abcdef';
const expected = { sqsMessageId: 'queue-id', deviceId: prefix + '-03', messageId: 'mqtt-id', receiptId: 'receipt-id' };
function logs() {
  return [
    {
      ...expected,
      lambdaRequestId: 'invocation',
      event: 'ingestion.record.completed',
      disposition: 'PROCESSED',
      receiptOutcome: 'DUPLICATE_SKIPPED',
    },
    {
      ...expected,
      lambdaRequestId: 'invocation',
      event: 'ingestion.receipt.completed',
      receiptOutcome: 'DUPLICATE_SKIPPED',
      commitScope: 'ROOT_TRANSACTION_COMPLETED',
    },
  ];
}
test('nonempty Replay requires exact scope, terminal success, real scan and zero failures', () => {
  const scope = { deviceId: expected.deviceId, seqFrom: 2 };
  const job = {
    status: 'COMPLETED',
    completedAt: '2026-10-13T00:00:00Z',
    scope,
    resultSummary: {
      sent: 1,
      scannedObjects: 1,
      scannedLines: 2,
      failed: 0,
      failedObjects: 0,
      failedLines: 0,
      sendFailures: 0,
    },
  };
  assert.match(replayGate(job, scope), /^PASS_/);
  assert.match(replayGate({ ...job, scope: { seqFrom: 2, deviceId: expected.deviceId } }, scope), /^PASS_/);
  for (const patch of [
    { sent: 0 },
    { sent: 2 },
    { scannedObjects: 0 },
    { scannedLines: 0 },
    { failed: 1 },
    { sendFailures: 1 },
    { failedObjects: undefined },
  ])
    assert.equal(replayGate({ ...job, resultSummary: { ...job.resultSummary, ...patch } }, scope), 'NO_RECEIPT');
  assert.equal(replayGate({ ...job, scope: { ...scope, deviceId: 'foreign' } }, scope), 'NO_RECEIPT');
  assert.equal(replayGate({ ...job, status: 'RUNNING' }, scope), 'NO_RECEIPT');
});
test('consumer proof binds root and final to all identities and one invocation', () => {
  assert.match(exactDuplicateGate(logs(), expected), /^PASS_/);
  assert.equal(exactDuplicateGate([logs()[0]], expected), 'NO_RECEIPT');
  for (const patch of [
    { deviceId: 'foreign' },
    { messageId: 'foreign' },
    { sqsMessageId: 'foreign' },
    { receiptId: 'unknown' },
    { lambdaRequestId: 'different' },
    { commitScope: 'SAVEPOINT_RELEASED' },
    { receiptOutcome: 'PROCESSED' },
  ])
    assert.equal(exactDuplicateGate([logs()[0], { ...logs()[1], ...patch }], expected), 'NO_RECEIPT');
});
test('single submission persists uncertainty first, never retries denial, timeout or missing ID', async () => {
  for (const error of [
    Object.assign(Error(), { name: 'KmsAccessDenied' }),
    Object.assign(Error(), { name: 'TimeoutError' }),
    null,
  ]) {
    let calls = 0;
    const persisted = [];
    const r = await submitOnce(
      async () => {
        calls++;
        assert.equal(persisted[0].gate, 'ATTEMPTING');
        if (error) throw error;
        return {};
      },
      (row) => persisted.push(structuredClone(row)),
      {},
    );
    assert.equal(calls, 1);
    assert.equal(r.retryAllowed, false);
    assert.equal(
      r.gate,
      error?.name === 'KmsAccessDenied' ? 'BLOCKED_PERMISSION_NO_RETRY' : 'UNKNOWN_SUBMISSION_NO_RETRY',
    );
  }
});
test('small consumer pages project metadata and stop on repeated tokens, failures and total budget', async () => {
  let calls = 0,
    clock = 0;
  const scope = { ...expected, startMs: 0, endMs: 1000 };
  const success = await collectExactConsumption(scope, {
    read: async () => ({
      events: logs().map((r) => ({ timestamp: 10, message: JSON.stringify({ ...r, password: 'never-export' }) })),
    }),
  });
  assert.match(success.gate, /^PASS_/);
  assert.ok(!JSON.stringify(success).includes('never-export'));
  const repeated = await collectExactConsumption(scope, {
    read: async (args) => {
      calls++;
      assert.equal(args[args.indexOf('--limit') + 1], '100');
      return { events: [], nextToken: 'same' };
    },
  });
  assert.equal(repeated.failure, 'REPEATED_LOG_TOKEN');
  assert.equal(calls, 2);
  const deadline = await collectExactConsumption(scope, {
    now: () => clock,
    budgetMs: 20,
    read: async () => {
      clock += 25;
      return { events: [], nextToken: 'next' };
    },
    sleep: async () => {},
  });
  assert.equal(deadline.failure, 'TOTAL_READ_DEADLINE');
  const denied = await collectExactConsumption(scope, {
    read: async () => {
      throw Error('sensitive');
    },
  });
  assert.equal(denied.failure, 'LOG_READ_FAILED');
  assert.ok(!JSON.stringify(denied).includes('sensitive'));
  await assert.rejects(collectExactConsumption({ ...scope, deviceId: 'foreign' }), /EXACT_BOUNDED/);
});
test('dedup gate refuses empty frames, missing tables and changed receipt/aggregate/archive data', () => {
  const frame = {
    readOnly: true,
    fingerprints: ['ingestion_receipts', 'telemetry_hourly', 'telemetry_daily', 'outbox_events'].map((table) => ({
      table,
      count: '1',
      digest: 'a'.repeat(32),
    })),
    receipts: Array.from({ length: 30 }, (_, id) => ({ id, result: 'PROCESSED' })),
    originalFingerprints: [],
  };
  assert.match(dedupGate(frame, structuredClone(frame)), /^PASS_/);
  const after = structuredClone(frame);
  after.fingerprints[1].digest = 'b'.repeat(32);
  assert.equal(dedupGate(frame, after), 'NO_RECEIPT');
  assert.equal(dedupGate({}, {}), 'NO_RECEIPT');
});
test('real readonly SQL verifies owned device/customer scope and leaves outside and owned rows intact', async () => {
  const pg = new PGlite();
  const devices = Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0'));
  const customers = ['a', 'b'].map((suffix, i) => ({
    id: String(i + 1).repeat(8) + '-1111-4111-8111-111111111111',
    name: prefix + '-' + suffix,
    suffix,
  }));
  try {
    await pg.exec(`CREATE TABLE customers(id text,name text); CREATE TABLE devices(id text,customer_id text,lifecycle_status text); CREATE TABLE device_certificates(id text,device_id text);
      CREATE TABLE ingestion_receipts(id text,device_id text,topic_type text,seq int,payload_hash text,result text,occurred_at timestamptz,processed_at timestamptz);
      CREATE TABLE telemetry_hourly(device_id text,sample_count int); CREATE TABLE telemetry_daily(device_id text,sample_count int);
      CREATE TABLE outbox_events(aggregate_id text,event_type text); CREATE TABLE replay_jobs(id text,scope jsonb,status text,result_summary jsonb,completed_at timestamptz);
      CREATE TABLE audit_logs(object_type text,object_id text,action text,result text);
      INSERT INTO devices VALUES('outside','outside','Active');`);
    for (const c of customers) await pg.query('INSERT INTO customers VALUES($1,$2)', [c.id, c.name]);
    for (const [i, id] of devices.entries())
      await pg.query('INSERT INTO devices VALUES($1,$2,$3)', [id, customers[i < 5 ? 0 : 1].id, 'Onboarded']);
    const sql = [];
    const client = {
      query: async (q, args) => {
        sql.push(q);
        if (q === 'SELECT current_database() AS database') return { rows: [{ database: 'fdp' }] };
        const r = await pg.query(q, args);
        return { rows: r.rows, rowCount: r.rows.length };
      },
    };
    const plan = { prefix, devices, customers, action: 'reliability-observe' };
    const before = (await pg.query('SELECT * FROM devices')).rows;
    const r = await executeFixture(client, plan);
    assert.equal(r.readOnly, true);
    assert.equal(r.devices.length, 10);
    assert.match(sql[0], /READ ONLY$/);
    assert.equal(sql.at(-1), 'ROLLBACK');
    assert.ok(sql.every((q) => !/^(INSERT|UPDATE|DELETE|CREATE|ALTER)/i.test(q)));
    assert.deepEqual((await pg.query('SELECT * FROM devices')).rows, before);
    await pg.query('UPDATE devices SET customer_id=$1 WHERE id=$2', ['outside', devices[0]]);
    await assert.rejects(executeFixture(client, plan), /RELIABILITY_DEVICE_SCOPE_DRIFT/);
    await assert.rejects(executeFixture(client, { ...plan, devices: [...devices, 'outside'] }), /EXACT_TEN/);
  } finally {
    await pg.close();
  }
});
test('Replay observation discovers only exact owned duplicate IDs without claiming Job-to-SQS producer mapping', async () => {
  const r = await collectExactConsumption(
    {
      deviceId: expected.deviceId,
      messageId: expected.messageId,
      receiptId: expected.receiptId,
      startMs: 10,
      endMs: 100,
    },
    {
      read: async (args) => {
        assert.match(args[args.indexOf('--filter-pattern') + 1], /messageId/);
        return {
          events: [
            ...logs().map((row) => ({ timestamp: 20, message: JSON.stringify(row) })),
            ...logs().map((row) => ({ timestamp: 5, message: JSON.stringify({ ...row, sqsMessageId: 'too-early' }) })),
            ...logs().map((row) => ({
              timestamp: 20,
              message: JSON.stringify({ ...row, sqsMessageId: 'foreign', deviceId: 'foreign' }),
            })),
          ],
        };
      },
    },
  );
  assert.match(r.gate, /^PASS_/);
  assert.deepEqual(r.matchedSqsMessageIds, ['queue-id']);
  assert.ok(r.rows.every((row) => row.sqsMessageId !== 'too-early'));
});
test('consumer reader fails closed on oversized pages and page cap without mutation recovery', async () => {
  const scope = { ...expected, startMs: 0, endMs: 100 };
  const oversized = await collectExactConsumption(scope, { read: async () => ({ events: Array(101).fill({}) }) });
  assert.equal(oversized.failure, 'LOG_PAGE_SIZE_EXCEEDED');
  let calls = 0;
  const capped = await collectExactConsumption(scope, {
    read: async () => ({ events: [], nextToken: String(++calls) }),
  });
  assert.equal(capped.failure, 'LOG_PAGE_LIMIT');
  assert.equal(calls, 8);
});
test('fresh own MQTT session closes predecessor, disables reconnect and cannot touch a foreign device', async () => {
  const { refreshOwnTelemetrySession } = await import('./qa09-reliability-closeout.mjs');
  const calls = [],
    clients = [];
  const k = {
    endpoint: 'example.iot.ap-southeast-1.amazonaws.com',
    cert: 'memory-only-cert',
    key: 'memory-only-key',
    client: { endAsync: async (force) => calls.push(['close', force]) },
  };
  const receipt = { prefix, devices: [expected.deviceId], checks: [] };
  const connectAsync = async (url, options) => {
    calls.push(['connect', url, options]);
    return { connected: true, on() {} };
  };
  await refreshOwnTelemetrySession({ id: expected.deviceId, k, receipt, clients, connectAsync });
  assert.equal(calls[0][0], 'close');
  assert.equal(calls[1][2].reconnectPeriod, 0);
  assert.equal(calls[1][2].connectTimeout, 15000);
  assert.equal(clients.length, 1);
  const before = calls.length;
  await assert.rejects(
    refreshOwnTelemetrySession({ id: 'foreign', k, receipt, clients, connectAsync }),
    /OWN_TELEMETRY_SESSION_REQUIRED/,
  );
  assert.equal(calls.length, before);
  k.client = {
    endAsync: async () => {
      throw Error('close failure');
    },
  };
  await assert.rejects(
    refreshOwnTelemetrySession({ id: expected.deviceId, k, receipt, clients, connectAsync }),
    /close failure/,
  );
  assert.equal(calls.length, before);
});
test('PUBACK has a bounded functional deadline, owns late rejection and never resubmits unknown publication', async () => {
  const { publishKnown } = await import('./run-qa09-ten-device-acceptance.mjs');
  let calls = 0,
    rejectPublish,
    fireTimeout,
    cleared = false;
  const client = {
    publishAsync: () => {
      calls++;
      return new Promise((_, reject) => {
        rejectPublish = reject;
      });
    },
  };
  const timers = {
    setTimeout: (fn, ms) => {
      assert.equal(ms, 45000);
      fireTimeout = fn;
      return 1;
    },
    clearTimeout: () => {
      cleared = true;
    },
  };
  const promise = publishKnown(client, 'own-topic', 'memory-only', 45000, timers);
  fireTimeout();
  await assert.rejects(promise, /PUBACK_TIMEOUT/);
  rejectPublish(Error('late rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(cleared, true);
  for (const deadline of [0, 45001, Infinity, '45000'])
    await assert.rejects(publishKnown(client, 'own-topic', 'memory-only', deadline), /INVALID_PUBACK_DEADLINE/);
  assert.equal(calls, 1);
});
test('cleanup never starts under unknown/running write ownership or retries an unknown cleanup Build', async () => {
  const { finishOwnReplayCleanup } = await import('./qa09-reliability-closeout.mjs');
  const calls = [],
    db = async (action) => calls.push(action);
  for (const state of [
    { baseline: [], terminal: false, postAttempted: true },
    { baseline: [], terminal: true, hold: true },
  ]) {
    assert.equal((await finishOwnReplayCleanup(state, db)).gate, 'BLOCKED_UNKNOWN_OR_RUNNING_REPLAY');
    assert.equal(calls.length, 0);
  }
  assert.equal((await finishOwnReplayCleanup({ baseline: [], terminal: true, postAttempted: true }, db)).gate, 'PASS');
  assert.deepEqual(calls, ['business-cleanup', 'business-audit']);
  let writes = 0;
  const failed = await finishOwnReplayCleanup({ baseline: [], terminal: true }, async () => {
    writes++;
    throw Error('START_OUTCOME_UNCONFIRMED');
  });
  assert.equal(failed.gate, 'FAIL_OR_UNKNOWN_NO_MUTATION_RETRY');
  assert.equal(writes, 1);
});
