import { assert, test } from 'vitest';
import { SERVICE_NAME, serviceLayers } from '../src/index.js';

test('summary-worker 骨架可加载', () => {
  assert.equal(SERVICE_NAME, 'summary-worker');
  assert.deepEqual(serviceLayers(), ['@fdp/database']);
});
