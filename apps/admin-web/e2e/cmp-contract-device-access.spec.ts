import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, p0Device, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

const deviceId = p0Device.id;
const peerId = 'dev-t07-peer';
const customerId = p0Device.customer.id;
const at = '2026-09-10T00:00:00Z';
const account = {
  deviceUserId: 'du-t07',
  customerId,
  customerName: 'T07 所属客户',
  username: 't07-night',
  displayName: '夜班设备账号',
  status: 'ACTIVE',
  activeDeviceCount: 1,
  version: 1,
  createdAt: at,
  updatedAt: at,
};
const fault = { error: { code: 'NOT_FOUND', message: 'fixture: unavailable' } };

test('B/T07 R10 R17 创建并分配可重试，解除当前设备不等于停用账号', async ({ page }) => {
  await seedSession(page, 'CustomerAdmin', { customerId });
  await page.setViewportSize({ width: 375, height: 900 });
  await routeP0Apis(page);
  const calls: { method: string; scope: string | null }[] = [];
  const assigned = new Set([peerId]);
  let created = false;
  let failCreate = true;
  let version = 1;
  let disabled = false;
  await page.route('**/api/v1/admin/devices/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return json(route, { data: { ...p0Device, id } });
  });
  await page.route('**/api/v1/admin/device-users**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const scope = url.searchParams.get('scopeDeviceId');
    calls.push({ method: request.method(), scope });
    if (scope !== deviceId && scope !== peerId) return json(route, fault, 404);
    const user = { ...account, version, status: disabled ? 'DISABLED' : 'ACTIVE' };
    const assignment = { assignmentId: 't07-a', deviceId: scope, status: 'ACTIVE', assignedAt: at, revokedAt: null };
    if (url.pathname.endsWith('/assignments/revoke')) {
      expect(request.postDataJSON().deviceIds).toEqual([scope]);
      expect(request.headers()['if-match']).toBe(String(version));
      assigned.delete(scope);
      version++;
      return json(route, { data: { deviceUserId: account.deviceUserId, deviceIds: [scope] } });
    }
    if (url.pathname.endsWith('/assignments')) {
      expect(request.postDataJSON().deviceIds).toEqual([scope]);
      expect(request.headers()['if-match']).toBe(String(version));
      assigned.add(scope);
      version++;
      return json(
        route,
        { data: { deviceUserId: account.deviceUserId, deviceIds: [scope], assignments: [assignment] } },
        201,
      );
    }
    if (url.pathname.endsWith('/disable')) {
      expect(request.headers()['if-match']).toBe(String(version));
      disabled = true;
      version++;
      return json(route, { data: { ...user, status: 'DISABLED', version } });
    }
    if (request.method() === 'POST') {
      expect(created).toBe(false);
      expect(request.postDataJSON().customerId).toBe(customerId);
      if (failCreate) {
        failCreate = false;
        return json(route, { error: { code: 'CONFLICT', message: 'fixture assignment failed' } }, 409);
      }
      created = true;
      assigned.add(scope);
      return json(route, { data: { ...user, assignedDeviceId: scope } }, 201);
    }
    if (url.pathname.endsWith('/du-t07')) {
      return assigned.has(scope) && created
        ? json(route, { data: { ...user, assignments: [assignment], syncStates: [] } })
        : json(route, fault, 404);
    }
    if (url.searchParams.get('eligible') === 'true')
      return json(route, { data: created && !assigned.has(scope) ? [{ ...user, activeDeviceCount: 0 }] : [] });
    return json(route, { data: created && assigned.has(scope) ? [user] : [] });
  });

  await page.goto('/device-users');
  await expect(page.getByTestId('device-user-choose-device')).toBeVisible();
  expect(calls).toEqual([]);
  await page.goto(`/devices/manage?deviceId=${deviceId}`);
  await page.getByTestId('manage-device-users').click();
  await expect(page.getByTestId('device-user-device-scope')).toContainText(deviceId);
  await page.getByTestId('device-user-create').click();
  const create = page.getByTestId('device-user-create-dialog');
  await create.getByTestId('create-username').fill(account.username);
  await create.getByTestId('create-display-name').fill(account.displayName);
  await create.getByTestId('create-password').fill('device-fixture-password');
  await create.getByTestId('create-user-submit').click();
  await expect(create.getByRole('alert')).toContainText('fixture assignment failed');
  await expect(create.getByTestId('create-username')).toHaveValue(account.username);
  expect(await layoutViolations(page)).toEqual([]);
  await expect(create.getByTestId('create-password')).toHaveValue('');
  await create.getByTestId('create-password').fill('device-fixture-password');
  await create.getByTestId('create-user-submit').click();
  await expect(page.getByTestId('action-notice')).toContainText('已创建并分配');
  await page.getByTestId('device-user-detail-du-t07').click();
  await expect(page.getByTestId('detail-customer')).toHaveText(account.customerName);
  await expect(page.getByTestId('device-user-assignments')).not.toContainText(peerId);

  await page.getByTestId('device-user-revoke').click();
  const revoke = page.getByTestId('device-user-revoke-dialog');
  await expect(revoke).toContainText('解除当前设备分配');
  await expect(revoke).not.toContainText(peerId);
  await revoke.getByTestId('revoke-reason').fill('fixture removal');
  await revoke.getByTestId('revoke-submit').click();
  await expect(page.getByTestId('device-user-empty')).toBeVisible();
  expect(assigned.has(peerId)).toBe(true);
  expect(disabled).toBe(false);

  await page.getByTestId('device-user-assign-existing').click();
  await page.getByTestId('existing-device-user').selectOption(account.deviceUserId);
  await page.getByTestId('existing-device-reason').fill('fixture reassignment');
  await page.getByTestId('assign-existing-submit').click();
  await expect(page.getByTestId('device-user-row-du-t07')).toBeVisible();

  await page.goto(`/device-users?deviceId=${peerId}&deviceUserId=du-t07`);
  await expect(page.getByTestId('device-user-detail')).toBeVisible();
  await expect(page.getByTestId('device-user-assignments')).toContainText(peerId);
  await page.getByTestId('device-user-disable').click();
  const disable = page.getByTestId('confirm-dialog');
  await expect(disable).toContainText('所有已分配设备');
  await disable.getByRole('textbox').fill('fixture account disable');
  await disable.getByRole('button', { name: /停用/ }).click();
  await expect(page.getByTestId('device-user-detail')).toContainText('已停用');
  expect(calls.every((call) => call.scope === deviceId || call.scope === peerId)).toBe(true);
});

test('B/T07 R15 旧授权直达定位合约或存量设备，并拒绝迟到详情覆盖', async ({ page }) => {
  await seedSession(page, 'PlatformOperator');
  const contractId = 't07-contract';
  const bound = { deviceId, customerId, label: 'T07 当前关联', associationId: 'a-t07', canCreate: true };
  const fallback = { deviceId: peerId, customerId, label: 'T07 存量设备', associationId: null, canCreate: true };
  const license = {
    licenseId: 'lic-t07',
    deviceId,
    customerId,
    status: 'Draft',
    validFrom: at,
    validTo: '2027-01-01T00:00:00Z',
    entitlements: [],
    signature: null,
    version: 4,
    effective: false,
    createdBy: 'fixture',
    createdAt: at,
    updatedAt: at,
  };
  const another = { ...license, licenseId: 'lic-t07-next', version: 5 };
  const legacy = { ...license, licenseId: 'lic-t07-legacy', deviceId: peerId };
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  let delayDetail = false;
  let issueAttempts = 0;
  await page.route('**/api/v1/admin/licenses**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const scopedDevice = url.searchParams.get('scopeDeviceId');
    const scopedContract = url.searchParams.get('contractId');
    if (url.pathname.endsWith('/issue')) {
      issueAttempts++;
      expect(scopedContract).toBe(contractId);
      expect(scopedDevice).toBe(deviceId);
      expect(url.searchParams.get('associationId')).toBe('a-t07');
      expect(request.headers()['if-match']).toBe('5');
      return json(route, { error: { code: 'CONFLICT', message: 'fixture association changed' } }, 409);
    }
    if (url.pathname.endsWith('/history')) {
      expect(scopedContract || scopedDevice).toBeTruthy();
      return json(route, { data: [] });
    }
    if (url.pathname.endsWith('/lic-t07') && scopedContract && delayDetail) {
      started = true;
      await delayed;
    }
    if (url.pathname.endsWith('/lic-t07-legacy')) return json(route, { data: legacy });
    if (url.pathname.endsWith('/lic-t07-next')) return json(route, { data: another });
    if (url.pathname.endsWith('/lic-t07')) return json(route, { data: license });
    if (!scopedContract && !scopedDevice) return json(route, fault, 404);
    const fallbackScope = scopedDevice === peerId;
    return json(route, {
      data: fallbackScope ? [legacy] : [license, another],
      meta: {
        nextCursor: null,
        scope: { contractId: fallbackScope ? null : contractId, devices: [fallbackScope ? fallback : bound] },
      },
    });
  });

  await page.goto('/licenses');
  await expect(page.getByTestId('license-choose-contract')).toBeVisible();
  await page.goto('/licenses?licenseId=lic-t07-legacy');
  await expect(page).toHaveURL(/deviceId=dev-t07-peer&licenseId=lic-t07-legacy$/);
  await expect(page.getByTestId('license-id')).toHaveText(legacy.licenseId);
  await page.goto('/licenses?licenseId=lic-t07');
  await expect(page).toHaveURL(/contractId=t07-contract&deviceId=dev-p0&licenseId=lic-t07$/);
  await expect(page.getByTestId('license-id')).toHaveText(license.licenseId);
  await expect(
    page.getByRole('navigation', { name: '面包屑' }).getByRole('link', { name: '合约详情' }),
  ).toHaveAttribute('href', '/contracts/detail?contractId=t07-contract');

  await page.goto('/licenses?contractId=t07-contract');
  delayDetail = true;
  await page.getByTestId('license-detail-lic-t07').click();
  await expect.poll(() => started).toBe(true);
  await page.getByTestId('license-detail-lic-t07-next').click();
  await expect(page.getByTestId('license-id')).toHaveText(another.licenseId);
  release();
  await expect(page.getByTestId('license-id')).toHaveText(another.licenseId);
  await page.getByTestId('license-issue').click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: /签发/ }).click();
  await expect(page.getByRole('alert')).toContainText('fixture association changed');
  expect(issueAttempts).toBe(1);
});
