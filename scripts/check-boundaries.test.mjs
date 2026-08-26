/**
 * ENG-01 check-boundaries 单元测试。
 * 运行：node --test scripts/check-boundaries.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspacePackages, checkBoundaries } from './check-boundaries.mjs';

function fixture(packages) {
  const root = mkdtempSync(join(tmpdir(), 'fdp-boundaries-'));
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

test('干净的依赖图通过检查', () => {
  const root = fixture({
    'packages/domain': { name: '@fdp/domain' },
    'apps/cloud-api': { name: '@fdp/cloud-api', dependencies: { '@fdp/domain': 'workspace:*' } },
  });
  const { violations, cycles } = checkBoundaries(loadWorkspacePackages(root));
  assert.deepEqual(violations, []);
  assert.deepEqual(cycles, []);
});

test('共享包反向依赖 apps 被识别为边界违规', () => {
  const root = fixture({
    'packages/domain': { name: '@fdp/domain', dependencies: { '@fdp/cloud-api': 'workspace:*' } },
    'apps/cloud-api': { name: '@fdp/cloud-api' },
  });
  const { violations } = checkBoundaries(loadWorkspacePackages(root));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /反向依赖/);
});

test('contracts 反向依赖 apps 被识别为边界违规', () => {
  const root = fixture({
    contracts: { name: '@fdp/contracts', dependencies: { '@fdp/admin-web': 'workspace:*' } },
    'apps/admin-web': { name: '@fdp/admin-web' },
  });
  const { violations } = checkBoundaries(loadWorkspacePackages(root));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /contracts/);
});

test('apps 之间互相依赖被识别为边界违规', () => {
  const root = fixture({
    'apps/a': { name: 'a', dependencies: { b: 'workspace:*' } },
    'apps/b': { name: 'b' },
  });
  const { violations } = checkBoundaries(loadWorkspacePackages(root));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /另一个应用/);
});

test('工作区循环依赖被检出', () => {
  const root = fixture({
    'packages/a': { name: 'a', dependencies: { b: 'workspace:*' } },
    'packages/b': { name: 'b', dependencies: { c: 'workspace:*' } },
    'packages/c': { name: 'c', dependencies: { a: 'workspace:*' } },
  });
  const { cycles } = checkBoundaries(loadWorkspacePackages(root));
  assert.equal(cycles.length, 1);
  assert.deepEqual(new Set(cycles[0]), new Set(['a', 'b', 'c']));
});

test('非工作区依赖（外部 npm 包）不参与检查', () => {
  const root = fixture({
    'packages/a': { name: 'a', dependencies: { lodash: '^4.0.0' } },
  });
  const { violations, cycles } = checkBoundaries(loadWorkspacePackages(root));
  assert.deepEqual(violations, []);
  assert.deepEqual(cycles, []);
});

test('当前仓库通过边界与循环依赖检查', () => {
  const root = new URL('..', import.meta.url).pathname;
  const packages = loadWorkspacePackages(root);
  assert.ok(packages.length >= 11, '应至少包含 11 个工作区');
  const { violations, cycles } = checkBoundaries(packages);
  assert.deepEqual(violations, []);
  assert.deepEqual(cycles, []);
});
