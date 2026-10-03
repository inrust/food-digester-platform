import nodeAssert from 'node:assert/strict';
import { test, assert } from 'vitest';
import { drainArchiveBatches } from '../src/outbox/drain.js';
import { createLeasedOutboxPublisher } from '../src/outbox/leased-publisher.js';
import type { DbClient } from '@fdp/database';

test('deadline between individual rows leaves unclaimed events durable for the next invocation', async () => {
  let sent = 0,
    claimed = 0;
  const client = {
    outboxEvent: {
      async findMany() {
        return [0, 1, 2].map((id) => ({ id: String(id), retryCount: 0 }));
      },
      async updateMany(args: { data: Record<string, unknown> }) {
        if (args.data.leaseToken) claimed++;
        return { count: 1 };
      },
    },
  } as unknown as DbClient;
  const publisher = createLeasedOutboxPublisher({
    client,
    eventTypes: ['ARCHIVE'],
    shouldContinue: () => sent < 1,
    send: async () => {
      sent++;
    },
  });
  const result = await publisher.publishPendingBatch();
  assert.equal(result.published, 1);
  assert.equal(claimed, 1);
  assert.equal(sent, 1);
});
test('drain clears a 300-event burst in bounded sequential batches with a single sender', async () => {
  let pending = 300,
    active = 0,
    peak = 0;
  const result = await drainArchiveBatches(async () => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    const count = Math.min(50, pending);
    pending -= count;
    active--;
    return { claimed: count, published: count, retried: 0, failed: 0 };
  });
  assert.equal(result.published, 300);
  assert.equal(result.batches, 7);
  assert.equal(result.stop, 'IDLE');
  assert.equal(peak, 1);
});
test('drain does not hot-loop failures or start work near deadline', async () => {
  let calls = 0;
  const publish = async () => {
    calls++;
    return { claimed: 1, published: 0, retried: 1, failed: 0 };
  };
  assert.equal((await drainArchiveBatches(publish)).stop, 'RETRY');
  assert.equal(calls, 1);
  assert.equal((await drainArchiveBatches(publish, { remainingMs: () => 9000 })).batches, 0);
  await nodeAssert.rejects(drainArchiveBatches(publish, { maxBatches: Infinity }));
});
