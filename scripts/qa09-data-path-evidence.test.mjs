import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDataPathLog, queueConsumptionGate, ownedDataPathGate } from './qa09-data-path-evidence.mjs';
const prefix = 'qa09-1234567890abcdef';
test('log projection redacts payload/error details and rejects unrecognized events', () => {
  const projected = projectDataPathLog(
    '2026 timestamp INFO ' +
      JSON.stringify({
        event: 'data-path.phase.completed',
        deviceId: prefix + '-01',
        phase: 'db-business',
        durationMs: 42,
        payload: 'secret',
        errorMessage: 'secret',
        errorCode: 'P2024',
        sqsMessageId: 'unsafe\nsecret',
      }),
  );
  assert.equal(projected.event, 'data-path.phase.completed');
  assert.equal(projected.durationMs, 42);
  assert.equal(projected.errorCode, 'P2024');
  assert.ok(!JSON.stringify(projected).includes('secret'));
  assert.equal(projectDataPathLog('{"event":"unknown","payload":"secret"}'), null);
  assert.equal(projectDataPathLog('not json'), null);
});
test('serialized AWS log projection preserves closed event names through the 20-sequence Gate', () => {
  const rows = Array.from({ length: 20 }, (_, i) => {
    const ids = {
      deviceId: prefix + '-01',
      seq: 10000 + i,
      topicType: 'telemetry',
      sqsMessageId: 'sqs-' + i,
      receiptId: 'receipt-' + i,
    };
    return [
      {
        ...ids,
        event: 'ingestion.receipt.completed',
        receiptOutcome: 'PROCESSED',
        commitScope: 'ROOT_TRANSACTION_COMPLETED',
      },
      { ...ids, event: 'ingestion.record.completed', disposition: 'PROCESSED' },
      ...['db-transaction', 'db-business', 'db-gap', 'telemetry-aggregate', 'telemetry-archive-outbox'].map(
        (phase) => ({ ...ids, event: 'data-path.phase.completed', phase, outcome: 'PASS' }),
      ),
    ];
  }).flat();
  rows.push({ deviceId: prefix + '-01', event: 'data-path.phase.completed', phase: 'console-read', outcome: 'PASS' });
  const projected = rows.map((row) => projectDataPathLog('timestamp INFO ' + JSON.stringify(row)));
  assert.equal(ownedDataPathGate(projected, prefix).gate, 'PASS_SCOPED_STAGE_EVIDENCE');
  assert.equal(
    ownedDataPathGate(
      projected.filter((row) => row.event !== 'ingestion.record.completed'),
      prefix,
    ).gate,
    'NO_RECEIPT',
  );
  assert.equal(projectDataPathLog('{"event":"ingestion.record.completed.evil","payload":"secret"}'), null);
});
test('specific redelivery needs matching SQS ID, final disposition and durable duplicate receipt', () => {
  const expected = { sqsMessageId: 'sqs-own', deviceId: prefix + '-01', messageId: 'TEL-own' };
  const rows = [
    {
      ...expected,
      event: 'ingestion.receipt.completed',
      receiptId: 'receipt',
      receiptOutcome: 'DUPLICATE_SKIPPED',
      commitScope: 'ROOT_TRANSACTION_COMPLETED',
    },
    {
      ...expected,
      event: 'ingestion.record.completed',
      receiptId: 'receipt',
      receiptOutcome: 'DUPLICATE_SKIPPED',
      disposition: 'PROCESSED',
    },
  ];
  assert.equal(queueConsumptionGate(rows, expected), 'PASS_SPECIFIC_SQS_REDELIVERY_COMPLETED');
  for (const patch of [
    { sqsMessageId: 'other' },
    { receiptId: 'other' },
    { disposition: 'RETRY' },
    { messageId: 'other' },
  ])
    assert.equal(queueConsumptionGate([rows[0], { ...rows[1], ...patch }], expected), 'NO_RECEIPT');
  assert.equal(
    queueConsumptionGate([{ ...rows[0], commitScope: 'ENCLOSING_TRANSACTION_CALLBACK_ONLY' }, rows[1]], expected),
    'NO_RECEIPT',
  );
  assert.equal(queueConsumptionGate(rows, null), 'NOT_RUN_NO_SUBMITTED_REDELIVERY');
});
test('20 sequence stage Gate rejects incomplete coverage and unrelated device evidence', () => {
  const rows = Array.from({ length: 20 }, (_, i) => {
    const ids = {
      deviceId: prefix + '-01',
      seq: 10000 + i,
      topicType: 'telemetry',
      sqsMessageId: 'sqs-' + i,
      receiptId: 'receipt-' + i,
    };
    return [
      {
        ...ids,
        event: 'ingestion.receipt.completed',
        receiptOutcome: 'PROCESSED',
        commitScope: 'ROOT_TRANSACTION_COMPLETED',
      },
      { ...ids, event: 'ingestion.record.completed', disposition: 'PROCESSED' },
      ...['db-transaction', 'db-business', 'db-gap', 'telemetry-aggregate', 'telemetry-archive-outbox'].map(
        (phase) => ({ ...ids, event: 'data-path.phase.completed', phase, outcome: 'PASS' }),
      ),
    ];
  }).flat();
  rows.push({ deviceId: prefix + '-01', phase: 'console-read', outcome: 'PASS' });
  assert.equal(ownedDataPathGate(rows, prefix).gate, 'PASS_SCOPED_STAGE_EVIDENCE');
  assert.equal(
    ownedDataPathGate(
      rows.filter((r) => r.seq !== 10003),
      prefix,
    ).gate,
    'NO_RECEIPT',
  );
  assert.equal(
    ownedDataPathGate(
      rows.map((r) => ({ ...r, deviceId: prefix + '-02' })),
      prefix,
    ).gate,
    'NO_RECEIPT',
  );
  assert.throws(() => ownedDataPathGate(rows, 'shared'));
});
