import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, STACK_NAMES } from '../src/index.js';

test('@fdp/infra 骨架可加载', () => {
  assert.equal(PACKAGE_NAME, '@fdp/infra');
  assert.deepEqual(STACK_NAMES, []);
});
