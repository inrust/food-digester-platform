import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, LAYER_CHAIN } from '../src/index.js';

test('@fdp/database 骨架可加载', () => {
  assert.equal(PACKAGE_NAME, '@fdp/database');
});

test('@fdp/database 依赖 @fdp/domain（单向分层）', () => {
  assert.equal(LAYER_CHAIN, '@fdp/domain -> @fdp/database');
});
