import { rejects } from 'node:assert/strict';
import { assert, test } from 'vitest';
import {
  withDataPathTrace,
  observeDataPathPhase,
  observeDataPathSyncPhase,
  setDataPathMessage,
  observeReceiptResult,
  observeRecordResult,
  beginDataPathPhase,
  beginFirstDataPathPhase,
} from '../src/data-path.js';

test('first database phases claim once per concurrent trace and completion retains acquisition owner', async () => {
  const rows: Record<string, unknown>[] = [];
  let finish!: (error?: unknown) => void;
  await Promise.all(
    ['a', 'b'].map((id) =>
      withDataPathTrace(
        { gatewayRequestId: id },
        async () => {
          for (let i = 0; i < 2; i++) {
            const end = beginFirstDataPathPhase('db-first-query');
            await Promise.resolve();
            end();
          }
          if (id === 'a') finish = beginDataPathPhase('db-first-connection');
        },
        (row) => rows.push(row),
      ),
    ),
  );
  withDataPathTrace({ gatewayRequestId: 'wrong-context' }, () => finish());
  assert.deepEqual(
    rows
      .filter((r) => r.phase === 'db-first-query')
      .map((r) => r.gatewayRequestId)
      .sort(),
    ['a', 'b'],
  );
  assert.equal(rows.find((r) => r.phase === 'db-first-connection')!.gatewayRequestId, 'a');
});

test('concurrent traces isolate SQS and device IDs and retain parent Lambda ID', async () => {
  const rows: Record<string, unknown>[] = [];
  await withDataPathTrace(
    { lambdaRequestId: 'lambda-1' },
    () =>
      Promise.all(
        ['a', 'b'].map((id) =>
          withDataPathTrace({ sqsMessageId: id }, async () => {
            setDataPathMessage({ deviceId: 'device-' + id, messageId: 'TEL-' + id, seq: 7 });
            await observeDataPathPhase('db-business', async () => {
              await Promise.resolve();
            });
            observeReceiptResult('PROCESSED', 'receipt-' + id, true);
            observeRecordResult('PROCESSED');
          }),
        ),
      ),
    (row) => rows.push(row),
  );
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.equal(row.lambdaRequestId, 'lambda-1');
    assert.equal(row.deviceId, 'device-' + row.sqsMessageId);
    if (row.event === 'ingestion.record.completed') assert.equal(row.receiptId, 'receipt-' + row.sqsMessageId);
  }
  observeRecordResult('PROCESSED');
  assert.equal(rows.length, 6, 'context must not escape its scope');
});

test('fixed schema hides raw exception and malformed correlation fields', async () => {
  const rows: Record<string, unknown>[] = [];
  const failure = Object.assign(new Error('secret-password SQL raw payload'), { code: 'P2024' });
  await withDataPathTrace(
    { deviceId: 'bad\nsecret-password', receivedAtMs: NaN, seq: -1 },
    async () => {
      await rejects(
        observeDataPathPhase('db-transaction', async () => {
          throw failure;
        }),
        (e) => e === failure,
      );
      observeReceiptResult('PROCESSED', 'bad/private-key', false);
      observeRecordResult('RETRY');
    },
    (row) => rows.push(row),
  );
  assert.equal(rows[0]!.errorCode, 'P2024');
  assert.equal(rows[0]!.outcome, 'FAIL');
  assert.equal(rows[0]!.includesConnectionWait, true);
  assert.equal(rows[1]!.commitScope, 'ENCLOSING_TRANSACTION_CALLBACK_ONLY');
  assert.equal(rows[2]!.businessDispatchCompleted, false);
  const text = JSON.stringify(rows);
  for (const secret of ['secret-password', 'SQL raw payload', 'private-key']) assert.notInclude(text, secret);
  assert.isFalse('seq' in rows[0]!);
  assert.isFalse('receivedAtMs' in rows[0]!);
});

test('throwing log transport cannot alter return values or retry errors', async () => {
  await withDataPathTrace(
    {},
    async () => {
      assert.equal(await observeDataPathPhase('db-business', async () => 42), 42);
      assert.equal(
        observeDataPathSyncPhase('response-serialize', () => 'response'),
        'response',
      );
      observeReceiptResult('DUPLICATE_SKIPPED', 'receipt', true);
      observeRecordResult('PROCESSED');
      const error = new Error('same instance');
      await rejects(
        observeDataPathPhase('db-business', async () => {
          throw error;
        }),
        (e) => e === error,
      );
    },
    () => {
      throw new Error('logger unavailable');
    },
  );
});

test('phase clock measures elapsed phase time and sync serialization failures', async () => {
  const rows: Record<string, unknown>[] = [];
  let tick = 0;
  await withDataPathTrace(
    {},
    async () => {
      await observeDataPathPhase('console-read', async () => undefined);
      assert.throws(() =>
        observeDataPathSyncPhase('response-serialize', () => {
          throw Error('private');
        }),
      );
    },
    (row) => rows.push(row),
    () => {
      tick += 10;
      return tick;
    },
  );
  assert.equal(rows[0]!.durationMs, 10);
  assert.equal(rows[1]!.durationMs, 10);
  assert.equal(rows[1]!.outcome, 'FAIL');
  assert.notInclude(JSON.stringify(rows), 'private');
});

test('manual phase timer emits once even when transaction catch revisits completion', async () => {
  const { beginDataPathPhase } = await import('../src/data-path.js');
  const rows: Record<string, unknown>[] = [];
  withDataPathTrace(
    {},
    () => {
      const finish = beginDataPathPhase('db-transaction-open');
      finish();
      finish(Object.assign(Error('secret'), { code: 'VERSION_CONFLICT' }));
    },
    (r) => rows.push(r),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, 'PASS');
  assert.equal(rows[0]!.includesConnectionWait, true);
});
