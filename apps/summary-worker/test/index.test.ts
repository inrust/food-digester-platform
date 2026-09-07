import { assert, test } from 'vitest';
import { SERVICE_NAME, serviceLayers } from '../src/index.js';

test('summary-worker 生产组合根可加载', () => {
  assert.equal(SERVICE_NAME, 'summary-worker');
  assert.deepEqual(serviceLayers(), ['@fdp/database', '@fdp/aws-clients']);
});
