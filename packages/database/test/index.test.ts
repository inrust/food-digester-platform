import { assert, test } from 'vitest';
import { DATABASE_POOL_CONFIG, PACKAGE_NAME, LAYER_CHAIN } from '../src/index.js';

test('@fdp/database 骨架可加载', () => {
  assert.equal(PACKAGE_NAME, '@fdp/database');
});

test('@fdp/database 依赖 @fdp/domain（单向分层）', () => {
  assert.equal(LAYER_CHAIN, '@fdp/domain -> @fdp/database');
});

test('Lambda PostgreSQL 连接池使用小规格 RDS 的显式连接预算', () => {
  assert.deepEqual(DATABASE_POOL_CONFIG, {
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  assert.isTrue(Object.isFrozen(DATABASE_POOL_CONFIG));
});
