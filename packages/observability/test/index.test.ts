import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME } from '../src/index.js';

test('@fdp/observability 骨架可加载', () => {
  assert.equal(PACKAGE_NAME, '@fdp/observability');
});
