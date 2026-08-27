/**
 * AUTH-01 验收：集中式权限矩阵（V1 固定）与角色越权语义。
 * 矩阵事实源：实施方案 §12.1 角色表 + BE-RBAC-01 验收约束 + DEC-012。
 */
import { assert, describe, test } from 'vitest';
import { hasPermission, permissionsOf, PERMISSION_MATRIX, PERMISSIONS, ROLES } from '../src/index.js';
import type { Permission, Role } from '../src/index.js';

const ALL = new Set<Permission>(PERMISSIONS);
const granted = (role: Role): Set<Permission> => new Set(permissionsOf(role));

describe('权限矩阵结构', () => {
  test('矩阵键与封闭角色集一一对应', () => {
    assert.deepEqual(Object.keys(PERMISSION_MATRIX).sort(), [...ROLES].sort());
  });

  test('每个权限点至少被一个角色持有（无死权限）', () => {
    for (const permission of PERMISSIONS) {
      assert.isTrue(
        ROLES.some((role) => hasPermission(role, permission)),
        `权限点 ${permission} 未分配给任何角色`,
      );
    }
  });

  test('PlatformSuperAdmin 持有全部权限', () => {
    assert.deepEqual(granted('PlatformSuperAdmin'), ALL);
  });

  test('BE-CERT-03：certificate:rotate 仅授权安全角色（PlatformSuperAdmin）持有', () => {
    for (const role of ROLES) {
      assert.equal(
        hasPermission(role, 'certificate:rotate'),
        role === 'PlatformSuperAdmin',
        `${role} 的 certificate:rotate 授权不符合预期`,
      );
    }
  });
});

describe('角色权限边界', () => {
  test('PlatformOperator：有设备/许可证/OTA/命令操作，无合约、角色、用户、设置、审批、导出权限', () => {
    const operator = granted('PlatformOperator');
    for (const allowed of [
      'customer:write',
      'device:write',
      'device:assign',
      'license:write',
      'ota:write',
      'command:send',
      'replay:create',
    ]) {
      assert.isTrue(operator.has(allowed as Permission), `PlatformOperator 应持有 ${allowed}`);
    }
    // BE-RBAC-01 验收：PlatformOperator 无合约、角色和 AWS 资源管理权限
    for (const denied of [
      'contract:write',
      'user:write',
      'role:read',
      'role:write',
      'settings:write',
      'onboarding:approve',
      'export:create',
      'audit:read',
    ] as const) {
      assert.isFalse(operator.has(denied), `PlatformOperator 不应持有 ${denied}`);
    }
  });

  test('Auditor：跨 Customer 只读 + 审计 + 导出，无任何写/操作权限', () => {
    const auditor = granted('Auditor');
    assert.isTrue(auditor.has('audit:read'));
    assert.isTrue(auditor.has('export:create'));
    for (const permission of auditor) {
      assert.isTrue(
        permission.endsWith(':read') || permission === 'export:create',
        `Auditor 不应持有非只读权限 ${permission}`,
      );
    }
  });

  test('CustomerAdmin：仅 Customer 域权限，无平台域权限', () => {
    const admin = granted('CustomerAdmin');
    for (const allowed of ['device-user:write', 'command:send', 'export:create'] as const) {
      assert.isTrue(admin.has(allowed));
    }
    for (const permission of admin) {
      assert.isFalse(
        [
          'customer',
          'contract',
          'license',
          'config',
          'ota',
          'onboarding',
          'user',
          'role',
          'settings',
          'audit',
          'replay',
        ].some((domain) => permission.startsWith(`${domain}:`)),
        `CustomerAdmin 不应持有平台域权限 ${permission}`,
      );
    }
  });

  test('CustomerViewer：只读，无任何写/操作/导出权限', () => {
    const viewer = granted('CustomerViewer');
    for (const permission of viewer) {
      assert.isTrue(permission.endsWith(':read'), `CustomerViewer 不应持有非只读权限 ${permission}`);
    }
    assert.isFalse(viewer.has('export:create'));
  });
});
