import nodeAssert from 'node:assert/strict';
import { test, assert } from 'vitest';
import { createCommandPhaseObserver } from '../src/admin/command/phase-observer.js';
test('phase observations preserve results and failures without exporting secrets or exception messages', async () => {
  const rows: unknown[] = [];
  let time = 0;
  const observe = createCommandPhaseObserver(
    (r) => rows.push(r),
    '00000000-0000-0000-0000-000000000001',
    true,
    () => time++,
  );
  assert.equal(await observe('iot-publish', async () => 42, 'QA09-ABC-CMD-0'), 42);
  const error = new Error('private payload credential should never leave');
  await nodeAssert.rejects(
    observe('db-secret', async () => {
      throw error;
    }),
  );
  assert.notInclude(JSON.stringify(rows), error.message);
  assert.include(JSON.stringify(rows), 'COMMAND_PHASE_FAILED');
  assert.include(JSON.stringify(rows), '"coldStart":true');
  const broken = createCommandPhaseObserver(
    () => {
      throw Error('sink');
    },
    '',
    false,
  );
  assert.equal(await broken('db-lease', async () => 7), 7);
});
