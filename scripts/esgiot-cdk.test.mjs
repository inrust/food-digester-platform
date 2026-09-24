import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOperationArgs, runWorkspaceBuild, WORKSPACE_BUILD_ARGS } from './esgiot-cdk.mjs';

test('CDK wrapper accepts synth/diff and requires explicit deploy stack', () => {
  assert.deepEqual(parseOperationArgs([]), { operation: 'synth', stacks: [] });
  assert.deepEqual(parseOperationArgs(['diff', 'AppDependencies']), {
    operation: 'diff',
    stacks: ['AppDependencies'],
  });
  assert.deepEqual(parseOperationArgs(['deploy', 'AppDependencies', 'fdp-test-app']), {
    operation: 'deploy',
    stacks: ['AppDependencies', 'fdp-test-app'],
  });
  assert.throws(() => parseOperationArgs(['deploy']), /explicit stack/u);
  assert.throws(() => parseOperationArgs(['destroy', 'fdp-test-app']), /synth\/diff\/deploy/u);
  assert.throws(() => parseOperationArgs(['diff', '--context']), /Stack names/u);
});

test('CDK wrapper builds the whole workspace and fails closed on build errors', () => {
  const calls = [];
  runWorkspaceBuild((command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.deepEqual(WORKSPACE_BUILD_ARGS, ['build']);
  assert.deepEqual(calls, [{ command: 'pnpm', args: ['build'], options: { stdio: 'inherit' } }]);
  assert.throws(() => runWorkspaceBuild(() => ({ status: 2 })), /Workspace build failed/u);
  assert.throws(() => runWorkspaceBuild(() => ({ status: null })), /Workspace build failed/u);
});
