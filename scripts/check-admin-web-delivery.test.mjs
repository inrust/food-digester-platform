import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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

function currentManifest() {
  const root = new URL('..', import.meta.url).pathname;
  return {
    root,
    manifest: JSON.parse(readFileSync(join(root, 'apps/admin-web/admin-web-delivery-manifest.json'), 'utf8')),
  };
}

test('FE-06 至 FE-10 任一任务或路由从事实源缺失时失败关闭', () => {
  const { root, manifest } = currentManifest();
  manifest.tasks = manifest.tasks.filter((task) => task !== 'FE-08');
  manifest.routes = manifest.routes.filter((route) => route.path !== '/alarms');
  const errors = auditAdminWebDelivery(root, { requireBuild: false, manifestOverride: manifest });
  assert.ok(errors.includes('交付清单缺少任务：FE-08'));
  assert.ok(errors.includes('交付清单缺少 P0 路由：/alarms'));
});

test('FE-06 至 FE-10 任一控制器或 operationId 缺失时失败关闭', () => {
  const { root, manifest } = currentManifest();
  manifest.operationIds = manifest.operationIds.filter((id) => id !== 'getDeviceConsole');
  const errors = auditAdminWebDelivery(root, {
    requireBuild: false,
    manifestOverride: manifest,
    controllerSourceOverride: 'export function DashboardController() {}',
  });
  assert.ok(errors.includes('交付清单缺少 P0 operationId：getDeviceConsole'));
  assert.ok(errors.includes('路由控制器未交付：DeviceViewController'));
});

test('App 移除显式页面分支时失败关闭', () => {
  const { root } = currentManifest();
  const appPath = join(root, 'apps/admin-web/src/app/App.tsx');
  const appSource = readFileSync(appPath, 'utf8').replace("case 'licenses':", "case 'licenses-removed':");
  const errors = auditAdminWebDelivery(root, { requireBuild: false, appSourceOverride: appSource });
  assert.ok(errors.includes('路由无显式页面分支：licenses'));
});
