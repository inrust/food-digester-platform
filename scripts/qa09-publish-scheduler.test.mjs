import test from 'node:test';
import assert from 'node:assert/strict';
import { publishScheduled } from './qa09-publish-scheduler.mjs';
test('scheduled publishing overlaps slow PUBACK and drains failures without abandoning in-flight writes', async () => {
  let active = 0,
    peak = 0,
    completed = 0;
  const events = Array.from({ length: 8 }, (_, id) => ({ id, due: 0 }));
  await publishScheduled(
    events,
    async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      completed++;
    },
    { maxInFlight: 4 },
  );
  assert.equal(peak, 4);
  assert.equal(completed, 8);
  assert.equal(active, 0);
  completed = 0;
  await assert.rejects(
    publishScheduled(
      events,
      async (m) => {
        await new Promise((r) => setTimeout(r, 5));
        completed++;
        if (m.id === 0) throw Error('PUBACK_FAILED');
      },
      { maxInFlight: 4 },
    ),
    /PUBACK_FAILED/,
  );
  assert.equal(completed, 4);
  await assert.rejects(
    publishScheduled([], () => {}, { maxInFlight: 65 }),
    /CONCURRENCY/,
  );
});
