import { test, assert } from 'vitest';
import { createContractWindowProbe } from './helpers/contract-window-probe.js';
test('offline marks default off and enabled CPU remains process-wide', () => {
  const off = createContractWindowProbe('off');
  off.mark('one');
  assert.deepEqual(off.marks, []);
  const on = createContractWindowProbe('on', true);
  on.mark('one');
  on.mark('two');
  assert.equal(on.marks.length, 2);
  assert.equal(on.marks[0]?.scope, 'PROCESS_ALL_THREADS');
  assert.isAtLeast(on.marks[1]!.us, on.marks[0]!.us);
});
