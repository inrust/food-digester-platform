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
import {
  CONSUMABLE_NAMES,
  CONSUMABLE_THRESHOLDS,
  DENY_REASON_LABELS,
  QUICK_COMMANDS,
} from '../src/pages/dashboard/dashboard-state.js';

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
  // FE-05 扩展路由（CT-06 矩阵外，权限与 BE-CUS-01/02 契约一致）
  const EXTENSION_ROUTES = ['/customers', '/sites'];
  const matrixRoutes = menuRoutes.filter((r) => !EXTENSION_ROUTES.includes(r.path));
  assert.equal(matrixRoutes.length, matrix.menus.length);
  // 扩展路由必须在此显式登记，防止路由表无约束膨胀
  assert.deepEqual(
    menuRoutes.filter((r) => EXTENSION_ROUTES.includes(r.path)).map((r) => r.path),
    EXTENSION_ROUTES,
  );

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

test('DEC-008：耗材名称与阈值与冻结策略一致', () => {
  const policy = readJson('contracts/domain/consumables-policy.json') as {
    status: string;
    display: { names: Record<string, string>; thresholds: Record<string, number> };
  };
  assert.equal(policy.status, 'frozen');
  assert.deepEqual({ ...CONSUMABLE_NAMES }, policy.display.names);
  assert.deepEqual({ ...CONSUMABLE_THRESHOLDS }, policy.display.thresholds);
});

test('CT-04：卡片快捷命令均在命令目录内（无协议外命令）', () => {
  const catalog = readJson('contracts/mqtt/command-catalog.json') as {
    commands: { command: string; highRisk: boolean }[];
  };
  const codes = new Set(catalog.commands.map((c) => c.command));
  for (const quick of QUICK_COMMANDS) {
    assert.ok(codes.has(quick.command), `快捷命令 ${quick.command} 不在 CT-04 目录`);
    // 卡片快捷动作为非高风险（高风险命令必须走确认凭证流程，不在卡片提供）
    assert.equal(catalog.commands.find((c) => c.command === quick.command)?.highRisk, false);
  }
});

test('BE-DASH-01：denyReason 文案覆盖契约枚举全集', () => {
  const api = readJson('contracts/rest/admin-dashboard-api.json') as {
    components: { schemas: { CommandAction: { properties: { denyReason: { enum: (string | null)[] } } } } };
  };
  const enumValues = api.components.schemas.CommandAction.properties.denyReason.enum.filter(
    (v): v is string => v !== null,
  );
  assert.deepEqual(Object.keys(DENY_REASON_LABELS).sort(), enumValues.sort());
});
