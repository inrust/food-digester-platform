import { assert, test } from 'vitest';
import type { Role } from '@fdp/auth';
import { menuForRoles, homePathForRoles, roleDisplayName } from '../src/menu/menu.js';
import type { MenuNode } from '../src/menu/menu.js';
import { resolveRoute } from '../src/router/guard.js';
import { FORBIDDEN_PATH, LOGIN_PATH } from '../src/router/routes.js';
import type { SessionSnapshot } from '../src/session/session-manager.js';

function menuPaths(roles: readonly Role[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: readonly MenuNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'leaf') paths.push(node.item.path);
      else for (const item of node.items) paths.push(item.path);
    }
  };
  walk(menuForRoles(roles));
  return paths;
}

function sessionOf(role: Role): SessionSnapshot {
  const customerId = role === 'CustomerAdmin' || role === 'CustomerViewer' ? 'cust-1' : null;
  return { username: 'user@example.com', roles: [role], customerId };
}

// 五种角色看到正确路由（验收基准）：CT-06 矩阵 9 条 + 扩展路由（FE-05 /customers、/sites；FE-08 /licenses；FE-09 /configurations、/device-users）
const EXPECTED_MENUS: Record<Role, string[]> = {
  PlatformSuperAdmin: [
    '/dashboard',
    '/devices/view',
    '/devices/operate',
    '/devices/groups',
    '/configurations',
    '/consumables',
    '/alarms',
    '/media',
    '/esg/overview',
    '/esg/devices',
    '/contracts',
    '/licenses',
    '/settings',
    '/customers',
    '/sites',
    '/device-users',
  ],
  PlatformOperator: [
    '/dashboard',
    '/devices/view',
    '/devices/operate',
    '/devices/groups',
    '/configurations',
    '/consumables',
    '/alarms',
    '/media',
    '/esg/overview',
    '/esg/devices',
    '/contracts',
    '/licenses',
    '/customers',
    '/sites',
  ],
  Auditor: [
    '/dashboard',
    '/devices/view',
    '/devices/groups',
    '/configurations',
    '/alarms',
    '/media',
    '/esg/overview',
    '/esg/devices',
    '/contracts',
    '/licenses',
    '/customers',
    '/sites',
    '/device-users',
  ],
  CustomerAdmin: [
    '/dashboard',
    '/devices/view',
    '/devices/operate',
    '/devices/groups',
    '/consumables',
    '/alarms',
    '/media',
    '/esg/overview',
    '/esg/devices',
    '/settings',
    '/sites',
    '/device-users',
  ],
  CustomerViewer: [
    '/dashboard',
    '/devices/view',
    '/devices/groups',
    '/consumables',
    '/alarms',
    '/media',
    '/esg/overview',
    '/esg/devices',
    '/sites',
  ],
};

for (const role of Object.keys(EXPECTED_MENUS) as Role[]) {
  test(`角色菜单：${role} 看到且仅看到其路由`, () => {
    assert.deepEqual(menuPaths([role]), EXPECTED_MENUS[role]);
    // 每个可见路由守卫均放行
    for (const path of EXPECTED_MENUS[role]) {
      const verdict = resolveRoute(path, sessionOf(role));
      assert.equal(verdict.kind, 'allow', `${role} 应可访问 ${path}`);
    }
  });
}

test('菜单结构：概览为顶级项，其后按 设备管理/ESG管理/合约管理/平台管理 分组，空分组隐藏', () => {
  const nodes = menuForRoles(['PlatformSuperAdmin']);
  assert.equal(nodes[0]?.kind, 'leaf');
  const groupIds = nodes.filter((n) => n.kind === 'group').map((n) => (n as { groupId: string }).groupId);
  assert.deepEqual(groupIds, ['device', 'esg', 'contract', 'platform']);
  // CustomerViewer 无合约路由 → contract 组隐藏
  const viewerGroups = menuForRoles(['CustomerViewer']).filter((n) => n.kind === 'group');
  assert.ok(!viewerGroups.some((g) => g.kind === 'group' && g.groupId === 'contract'));
});

test('无 Token 不能进入受保护页：重定向登录并携带 returnTo', () => {
  const verdict = resolveRoute('/devices/operate', null);
  assert.deepEqual(verdict, { kind: 'redirect-login', returnTo: '/devices/operate' });
});

test('角色不符 → forbidden（403 无权界面），会话保留', () => {
  const verdict = resolveRoute('/contracts', sessionOf('CustomerViewer'));
  assert.equal(verdict.kind, 'forbidden');
  const verdict2 = resolveRoute('/settings', sessionOf('Auditor'));
  assert.equal(verdict2.kind, 'forbidden');
});

test('子页面守卫：/contracts/new 继承合约菜单角色；未知路径 not-found', () => {
  assert.equal(resolveRoute('/contracts/new', sessionOf('Auditor')).kind, 'allow');
  assert.equal(resolveRoute('/contracts/new', sessionOf('CustomerAdmin')).kind, 'forbidden');
  assert.equal(resolveRoute('/devices/manage', sessionOf('CustomerViewer')).kind, 'allow');
  assert.equal(resolveRoute('/no/such/page', sessionOf('PlatformSuperAdmin')).kind, 'not-found');
});

test('登录页公开；已登录访问登录页回到角色首页', () => {
  assert.equal(resolveRoute(LOGIN_PATH, null).kind, 'allow');
  assert.equal(resolveRoute(FORBIDDEN_PATH, null).kind, 'allow');
  for (const role of Object.keys(EXPECTED_MENUS) as Role[]) {
    const verdict = resolveRoute(LOGIN_PATH, sessionOf(role));
    assert.deepEqual(verdict, { kind: 'redirect-home', home: '/dashboard' });
    assert.equal(homePathForRoles([role]), '/dashboard');
  }
});

test('DEC-012 角色显示名：冻结映射生效，未冻结角色回退角色代码', () => {
  assert.equal(roleDisplayName('PlatformSuperAdmin'), '平台管理员');
  assert.equal(roleDisplayName('PlatformOperator'), '设备操作员');
  assert.equal(roleDisplayName('Auditor'), 'Auditor');
});
