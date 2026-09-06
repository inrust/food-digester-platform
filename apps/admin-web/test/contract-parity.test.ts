/**
 * FE-01 契约一致性测试：路由/菜单/角色显示名/错误码与冻结事实源逐条核对。
 * 任何单边修改（APP_ROUTES 或契约文件）都会使本测试失败。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, test } from 'vitest';
import { ROLES } from '@fdp/auth';
import { FROZEN_ROLE_DISPLAY_NAMES } from '../src/menu/menu.js';
import { APP_ROUTES } from '../src/router/routes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface TraceabilityMenu {
  menuId: string;
  label: string;
  pageState: string;
  routeId: string;
  roles: string[];
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, relative), 'utf8'));
}

test('CT-06：9 个菜单项的 routeId/label/pageState/roles 与路由注册表一致', () => {
  const matrix = readJson('contracts/prototype-traceability.yaml') as { menus: TraceabilityMenu[]; roles: string[] };
  assert.equal(matrix.menus.length, 9);

  const menuRoutes = APP_ROUTES.filter((route) => route.menuGroup !== null);
  assert.equal(menuRoutes.length, matrix.menus.length);

  for (const menu of matrix.menus) {
    const route = menuRoutes.find((r) => r.path === menu.routeId);
    assert.ok(route !== undefined, `缺少菜单路由 ${menu.routeId}`);
    assert.equal(route.label, menu.label, `${menu.routeId} label 不一致`);
    assert.equal(route.pageState, menu.pageState, `${menu.routeId} pageState 不一致`);
    assert.deepEqual([...route.roles].sort(), [...menu.roles].sort(), `${menu.routeId} roles 不一致`);
    // 矩阵角色必须属于封闭角色集
    for (const role of menu.roles) {
      assert.ok((ROLES as readonly string[]).includes(role), `未知角色 ${role}`);
    }
  }
  // 矩阵角色全集 = 五角色
  assert.deepEqual([...matrix.roles].sort(), [...ROLES].sort());
});

test('DEC-012：角色映射策略 frozen@1.0.0，冻结显示名与策略一致', () => {
  const policy = readJson('contracts/domain/role-mapping-policy.json') as {
    status: string;
    policyVersion: string;
    roleMappings: { mappings: { systemRole: string; uiName: string }[] };
  };
  assert.equal(policy.status, 'frozen');
  assert.equal(policy.policyVersion, '1.0.0');
  for (const mapping of policy.roleMappings.mappings) {
    const display = FROZEN_ROLE_DISPLAY_NAMES[mapping.systemRole as keyof typeof FROZEN_ROLE_DISPLAY_NAMES];
    assert.equal(display, mapping.uiName, `${mapping.systemRole} 显示名与 DEC-012 不一致`);
  }
});

test('CT-05：401/403 稳定错误码存在（UNAUTHENTICATED / FORBIDDEN）', () => {
  const catalog = readJson('contracts/rest/error-codes.json') as {
    errorCodes: { code: string; httpStatus: number }[];
  };
  const byCode = new Map(catalog.errorCodes.map((e) => [e.code, e.httpStatus]));
  assert.equal(byCode.get('UNAUTHENTICATED'), 401);
  assert.equal(byCode.get('FORBIDDEN'), 403);
});
