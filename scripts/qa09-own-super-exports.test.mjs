import test from 'node:test';
import assert from 'node:assert/strict';
import { runOwnSuperExports } from './qa09-own-super-exports.mjs';
test('export scope rejects a foreign device before API, AWS or output writes', async () => {
  let calls = 0;
  await assert.rejects(
    runOwnSuperExports(
      {
        receipt: { prefix: 'qa09-1234567890abcdef', devices: ['foreign'], customers: [] },
        api() {
          calls++;
        },
      },
      '/tmp/qa09-foreign-export.json',
    ),
  );
  assert.equal(calls, 0);
});
