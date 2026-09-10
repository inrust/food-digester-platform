import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditAdminWebDelivery } from './check-admin-web-delivery.mjs';

test('当前管理后台源代码满足入口与组合根交付约束', () => {
  const root = new URL('..', import.meta.url).pathname;
  assert.deepEqual(auditAdminWebDelivery(root, { requireBuild: false }), []);
});

test('缺少入口和构建产物时失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-admin-web-delivery-'));
  const errors = auditAdminWebDelivery(root);
  assert.ok(errors.some((error) => error.includes('package.json')));
  assert.ok(errors.some((error) => error.includes('index.html')));
  assert.ok(errors.some((error) => error.includes('JavaScript') || error.includes('assets')));
});
