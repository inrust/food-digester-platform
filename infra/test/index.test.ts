import { assert, test } from 'vitest';
import { PACKAGE_NAME, STACK_IDS } from '../src/index.js';

test('@fdp/infra 暴露应用依赖 Stack', () => {
  assert.equal(PACKAGE_NAME, '@fdp/infra');
  assert.deepEqual([...STACK_IDS], ['AppDependencies']);
});
