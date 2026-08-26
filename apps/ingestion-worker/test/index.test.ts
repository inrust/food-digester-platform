import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_NAME, serviceLayers } from '../src/index.js';

test('ingestion-worker 骨架可加载', () => {
  assert.equal(SERVICE_NAME, 'ingestion-worker');
  assert.deepEqual(serviceLayers(), ['@fdp/domain', '@fdp/observability']);
});
