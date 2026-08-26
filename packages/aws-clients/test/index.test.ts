import { assert, test } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

test('@fdp/aws-clients 骨架可加载', () => {
  assert.equal(PACKAGE_NAME, '@fdp/aws-clients');
});
