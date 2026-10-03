import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qa09VersionInputs } from './qa09-version-inputs.mjs';
test('version binding preserves prior defaults and accepts exact new target', () => {
  assert.equal(qa09VersionInputs({}).commit, 'e759626a3e965cd9c0330b8e73bc713c0386d7de');
  assert.deepEqual(
    qa09VersionInputs({
      QA09_EXPECTED_COMMIT: '7c6f356b6917accd6cf562cb4bd6d5990416740f',
      QA09_DEPLOY_RUN_ID: '37108925188',
    }),
    { commit: '7c6f356b6917accd6cf562cb4bd6d5990416740f', deployRunId: '37108925188' },
  );
});
test('invalid version input is rejected before any AWS operation', () => {
  for (const v of ['main', '', '7c6f356', '../secret', 'A'.repeat(40)])
    assert.throws(() => qa09VersionInputs({ QA09_EXPECTED_COMMIT: v }));
  for (const v of ['', '-1', '1;deploy', 'x']) assert.throws(() => qa09VersionInputs({ QA09_DEPLOY_RUN_ID: v }));
});
