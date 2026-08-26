import { assert, test } from 'vitest';
import { SERVICE_NAME, serviceLayers } from '../src/index.js';

test('archive-worker 骨架可加载', () => {
  assert.equal(SERVICE_NAME, 'archive-worker');
  assert.deepEqual(serviceLayers(), ['@fdp/database', '@fdp/aws-clients']);
});
