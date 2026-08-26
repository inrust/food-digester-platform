import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_NAME, serviceLayers } from '../src/index.js';

test('cloud-api 骨架可加载', () => {
  assert.equal(SERVICE_NAME, 'cloud-api');
});

test('cloud-api 仅依赖共享包（apps -> packages 单向）', () => {
  assert.deepEqual(serviceLayers(), ['@fdp/domain', '@fdp/database', '@fdp/observability']);
});
