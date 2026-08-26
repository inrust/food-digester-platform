import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAME } from '../src/index.js';

test('admin-web 骨架可加载', () => {
  assert.equal(APP_NAME, 'admin-web');
});
