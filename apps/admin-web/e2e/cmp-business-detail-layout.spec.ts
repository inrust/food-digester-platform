import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { p0Device, json, layoutViolations, routeFe11To15Apis, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

const time = '2026-09-10T00:00:00Z';
const longValue = 'fixture-long-detail-'.repeat(9);

test('CMP-35/37 platform users expose full values and the searchable matrix stays read-only', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);
  const row = {
    userId: 'cmp-platform-user',
    email: 'sample-with-a-deliberately-long-local-part@example.test',
    displayName: longValue,
    status: 'DISABLED',
    mfaEnabled: true,
    roles: ['CustomerAdmin'],
    customerId: longValue + 'customer',
    createdAt: time,
    updatedAt: time,
  };
  const auditor = {
    ...row,
    userId: 'legacy-auditor',
    email: 'auditor@example.test',
    displayName: 'Legacy auditor',
    status: 'ACTIVE',
    roles: ['Auditor'],
    customerId: null,
  };
  const userWrites: string[] = [];
  await page.route('**/api/v1/admin/users**', (route) => {
    if (route.request().method() !== 'GET') userWrites.push(route.request().method());
    return json(route, { data: [row, auditor], meta: { nextCursor: null } });
  });
  await page.route('**/api/v1/admin/settings**', (route) => json(route, { data: [], meta: {} }));
  await page.goto('/settings');

  const list = page.getByTestId('platform-users-tab').getByTestId('cursor-table');
  const scroller = list.locator('.table-scroll');
  await scroller.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroller.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  const profileButton = list.getByTestId('user-profile-cmp-platform-user');
  await profileButton.click();
  const profile = page.getByTestId('user-profile-dialog');
  for (const value of [row.email, row.displayName, row.customerId]) await expect(profile).toContainText(value);
  expect(await layoutViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(profileButton).toBeFocused();
  await expect(list.getByTestId('user-roles-cmp-platform-user')).toBeDisabled();
  await expect(list.getByTestId('user-scope-cmp-platform-user')).toBeDisabled();

  await page.getByTestId('user-invite-open').click();
  const invite = page.getByTestId('user-invite-form');
  await expect(invite.getByRole('checkbox')).toHaveCount(2);
  await expect(invite.getByRole('checkbox', { name: '平台管理员' })).not.toBeChecked();
  await expect(invite.getByRole('checkbox', { name: '运维人员' })).not.toBeChecked();
  await page.keyboard.press('Escape');

  await list.getByTestId('user-roles-legacy-auditor').click();
  const assignment = page.getByTestId('user-roles-form');
  await expect(assignment.getByRole('checkbox')).toHaveCount(2);
  await expect(assignment.getByRole('checkbox', { name: '平台管理员' })).not.toBeChecked();
  await expect(assignment.getByRole('checkbox', { name: '运维人员' })).not.toBeChecked();
  await expect(assignment.getByTestId('assign-submit')).toBeDisabled();
  await expect(assignment).toContainText('保留该账号已有的 Auditor 审计角色');
  await page.keyboard.press('Escape');
  expect(userWrites).toEqual([]);

  const matrix = page.getByTestId('rbac-matrix');
  const role = matrix.getByRole('combobox', { name: '按角色查看' });
  const search = matrix.getByLabel('查找权限或模块');
  const table = matrix.getByTestId('rbac-table');
  await expect(role.locator('option')).toHaveText(['全部角色', '平台管理员', '运维人员']);
  await search.fill('合约');
  await expect(table.getByRole('rowheader', { name: 'contract:write' })).toBeVisible();
  await expect(table.getByTestId('rbac-PlatformSuperAdmin-contract:write')).toHaveText('已授权');
  await expect(table.getByTestId('rbac-PlatformOperator-contract:write')).toHaveText('未授权');
  await role.selectOption('PlatformOperator');
  await search.fill('contract:read');
  await expect(table.getByTestId('rbac-PlatformOperator-contract:read')).toHaveText('已授权');
  await expect(table.getByTestId('rbac-PlatformSuperAdmin-contract:read')).toHaveCount(0);
  await expect(table.getByTestId('rbac-PlatformOperator-contract:write')).toHaveCount(0);
  await expect(table.locator('input, button, select')).toHaveCount(0);
  await search.fill('no-matching-fixture-permission');
  await expect(matrix.getByRole('status')).toHaveText('没有匹配的权限');
  expect(await layoutViolations(page)).toEqual([]);
});

test('CMP-38 independent details distinguish published notifications, acknowledged snapshots and unknown device application', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await seedSession(page, 'CustomerAdmin', { customerId: 'cust-a' });
  await page.addInitScript(() => window.localStorage.setItem('fdp.admin.lang.v1', 'en'));
  await routeP0Apis(page);
  await page.route('**/api/v1/admin/users**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/settings**', (route) => json(route, { data: [], meta: {} }));
  const record = {
    deviceUserId: 'cmp-device-user',
    customerId: 'cust-a',
    username: 'fixture-device-user',
    displayName: longValue,
    status: 'ACTIVE',
    version: 6,
    activeDeviceCount: 1,
    createdAt: time,
    updatedAt: time,
  };
  const requests: { method: string; customerId: string | null }[] = [];
  await page.route('**/api/v1/admin/device-users**', (route) => {
    const url = new URL(route.request().url());
    requests.push({ method: route.request().method(), customerId: url.searchParams.get('scopeDeviceId') });
    const detail = {
      ...record,
      assignments: [
        { assignmentId: 'cmp-assignment', deviceId: longValue, status: 'ACTIVE', assignedAt: time, revokedAt: null },
      ],
      syncStates: [
        {
          deviceId: longValue,
          entityVersion: 6,
          notificationStatus: 'PUBLISHED',
          notificationPublishedAt: time,
          deliveredEntityVersion: 5,
          snapshotStatus: 'ACKNOWLEDGED',
          snapshotServedAt: time,
          deviceReportedLastSyncAt: time,
          deviceApplyStatus: 'NOT_REPORTED',
        },
      ],
    };
    return json(route, {
      data: url.pathname.endsWith('/cmp-device-user') ? detail : [record],
      meta: { nextCursor: null },
    });
  });

  await page.route('**/api/v1/admin/devices/**', (route) =>
    json(route, {
      data: { ...p0Device, id: longValue },
    }),
  );
  await page.goto('/settings');
  await expect(page.getByTestId('settings-device-users-link')).toHaveCount(0);
  await page.goto(`/device-users?deviceId=${encodeURIComponent(longValue)}`);
  await page.getByTestId('device-user-detail-cmp-device-user').click();
  const detail = page.getByTestId('device-user-detail');
  await expect(detail.getByRole('region', { name: 'Account information' })).toContainText(longValue);
  await expect(detail.getByTestId('user-assignment-cmp-assignment')).toContainText(longValue);
  const notification = detail.getByRole('region', { name: 'Notification delivery' });
  await expect(notification).toContainText('Delivered');
  await expect(notification).toContainText('v6');
  const confirmation = detail.getByRole('region', { name: 'Snapshot and application confirmation' });
  await expect(confirmation).toContainText('v5');
  await expect(confirmation.getByTestId('device-user-apply-status')).toHaveText('Not reported by the device');
  const edit = detail.getByTestId('device-user-edit');
  await edit.click();
  await page.getByTestId('edit-display-name').fill('Unsaved fixture value');
  await page.keyboard.press('Escape');
  await expect(edit).toBeFocused();
  await expect(detail.getByRole('region', { name: 'Account information' })).toContainText(longValue);
  expect(await layoutViolations(page)).toEqual([]);
  expect(requests).toHaveLength(2);
  expect(requests.every(({ customerId }) => customerId === longValue)).toBe(true);
  expect(requests.every(({ method }) => method === 'GET')).toBe(true);
});

test('CMP-44 audit JSON scrolls independently, redacts nested values and keeps the detail keyboard loop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await seedSession(page, 'Auditor');
  await routeFe11To15Apis(page);
  const record = {
    auditId: 'audit-fe15',
    actorId: 'auditor-fixture',
    actorRole: 'Auditor',
    customerId: 'cust-a',
    objectType: 'Device',
    objectId: longValue,
    action: 'COMMAND_CREATED',
    result: 'SUCCESS',
    createdAt: time,
  };
  const requests: string[] = [];
  await page.route('**/api/v1/admin/audit-logs**', (route) => {
    requests.push(route.request().method());
    const detail = {
      ...record,
      reason: 'Synthetic reason',
      requestId: 'cmp-audit-request',
      ip: '192.0.2.1',
      userAgent: longValue,
      beforeValue: {
        nested: Array.from({ length: 25 }, () => ({ note: longValue, privateKey: 'fixture-redact-before' })),
      },
      afterValue: { authorization: 'fixture-redact-after', status: 'SUCCESS' },
    };
    return json(route, {
      data: new URL(route.request().url()).pathname.endsWith('/audit-fe15') ? detail : [record],
      meta: { nextCursor: null },
    });
  });
  await page.goto('/audit-logs');
  const opener = page.getByTestId('audit-detail-audit-fe15');
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('audit-detail-modal');
  const before = dialog.getByTestId('audit-detail-before');
  const after = dialog.getByTestId('audit-detail-after');
  const closeButton = dialog.getByRole('button', { name: '关闭' });
  await expect(dialog.getByRole('region', { name: '事件概要' })).toContainText('Synthetic reason');
  await expect(dialog.getByRole('region', { name: '追踪信息' })).toContainText('cmp-audit-request');
  await expect(before).toContainText('[REDACTED]');
  await expect(after).toContainText('[REDACTED]');
  await expect(page.locator('body')).not.toContainText(/fixture-redact-(before|after)/);
  expect(await before.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await before.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await closeButton.focus();
  await page.keyboard.press('Tab');
  await expect(before).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => before.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await expect.poll(() => before.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  await expect(after).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  expect(await layoutViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  expect(requests).toEqual(['GET', 'GET']);
});
