import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './qa08-fixture.js';
import type { Qa08 } from './qa08-fixture.js';
import { layoutViolations } from './qa05-api-fixtures.js';
import { GROUPS, ABSENCE, VIEWPORTS, validateBindings } from '../../../scripts/qa08-bindings.mjs';
const matrix = JSON.parse(
  readFileSync(new URL('../../../contracts/prototype-traceability.yaml', import.meta.url), 'utf8'),
);
validateBindings(matrix);
const roots: Record<string, string> = {
  dashboard: 'dashboard-page',
  'device-view': 'device-view-page',
  'device-operate': 'device-operate-page',
  'device-group': 'device-groups-page',
  'device-manage': 'device-manage-page',
  'device-consumable': 'consumables-page',
  'contract-modify': 'contracts-page',
  'contract-new': 'contract-new-page',
  'contract-detail': 'contract-detail-page',
  'esg-overview': 'esg-overview-page',
  'esg-device': 'esg-devices-page',
  settings: 'settings-page',
};
async function switchRole(page: Page, role: string) {
  await page.evaluate((nextRole) => {
    const session = JSON.parse(sessionStorage.getItem('fdp.admin.session.v1')!);
    session.roles = [nextRole];
    sessionStorage.setItem('fdp.admin.session.v1', JSON.stringify(session));
  }, role);
}
async function scope(page: Page, q: Qa08, apply?: string) {
  await page.locator('#scope-region').selectOption(q.f.region);
  await page.locator('#scope-subregion').selectOption(q.f.subregion);
  await page.locator('#scope-site').selectOption(q.f.siteId);
  await page.locator('#scope-device').selectOption(q.f.deviceId);
  if (apply) await page.getByTestId(apply).click();
}
async function close(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function axes(page: Page, container: string) {
  const group = page.getByTestId(container).getByTestId('four-axis-badges').first();
  for (const [axis, value] of Object.entries({
    connectivity: 'ONLINE',
    lifecycle: 'Active',
    operational: 'Active',
    license: 'Active',
  }))
    await expect(group.locator(`[data-axis="${axis}"]`)).toHaveAttribute('data-value', value);
}
async function columns(page: Page, scopeId: string, names: string[]) {
  for (const name of names)
    await expect(page.getByTestId(scopeId).getByRole('columnheader', { name, exact: true })).toBeVisible();
}
async function checkGroup(key: string, page: Page, q: Qa08, go: () => Promise<void>) {
  const f = q.f;
  await go();
  switch (key) {
    case 'dashboard.summary':
      for (const [id, value] of Object.entries({
        'metric-contracts': f.n,
        'metric-devices': 10,
        'metric-online': 10,
        'metric-carbon': f.n,
      }))
        await expect(page.getByTestId(id)).toContainText(String(value));
      await expect(page.getByTestId('metric-online')).toContainText('100%');
      break;
    case 'dashboard.collections':
      await expect(page.getByTestId('latest-alarms')).toContainText(f.activity);
      await expect(page.locator('[data-testid^="device-card-"]')).toHaveCount(10);
      await expect(page.getByTestId(`device-card-${f.deviceId}`)).toContainText(f.alias);
      break;
    case 'dashboard.commands':
      for (const command of ['START', 'STOP', 'REBOOT']) {
        await page.getByTestId(`action-${command}-${f.deviceId}`).click();
        await expect(page.getByTestId('confirm-dialog')).toContainText(f.deviceId);
        const before = q.calls.filter((c) => c.method === 'POST').length;
        await close(page);
        expect(q.calls.filter((c) => c.method === 'POST').length).toBe(before);
      }
      q.guards.dangerousConfirmation = true;
      break;
    case 'dashboard.upgrade':
      await page.getByTestId(`action-upgrade-${f.deviceId}`).click();
      await expect(page).toHaveURL(/\/ota\/campaigns$/);
      break;
    case 'device-view.scope':
    case 'esg-device.scope': {
      await scope(page, q, key.startsWith('device-view') ? 'view-apply' : 'esg-device-apply');
      await expect(page.locator('#scope-device')).toHaveValue(f.deviceId);
      await page.locator('#scope-region').selectOption('');
      await expect(page.locator('#scope-subregion')).toHaveValue('');
      await expect(page.locator('#scope-site')).toHaveValue('');
      await expect(page.locator('#scope-device')).toHaveValue('');
      await expect(page.locator('#scope-subregion')).toBeDisabled();
      q.guards.cascadingReset = true;
      break;
    }
    case 'device-view.console':
      await expect(page.getByTestId('console-components').locator('[data-testid^="component-"]')).toHaveCount(5);
      for (const component of ['overall', 'temperature', 'humidity', 'weight', 'gas'])
        await expect(page.getByTestId(`component-${component}`)).toContainText('正常');
      await expect(page.getByTestId('sensor-currentAmp')).toContainText(String(f.n));
      await expect(page.getByTestId('sensor-currentAmp')).toContainText('A');
      await expect(page.getByTestId('console-consumables')).toContainText('31%');
      await expect(page.getByTestId('console-alarms')).toContainText(f.activity);
      await expect(page.getByTestId('console-esg7d')).toContainText(String(f.n));
      break;
    case 'device-view.media':
      await expect(page.getByTestId('media-image')).toHaveAttribute('src', '/qa08-image.svg');
      await expect(page.getByTestId('media-video')).toHaveCount(0);
      await page.getByTestId('media-refresh').click();
      await expect(page.getByTestId('media-image')).toBeVisible();
      await expect(page.getByTestId('page-content').locator('video')).toHaveCount(0);
      q.guards.staticMedia = true;
      break;
    case 'device-operate.commands':
      for (const [button, command] of [
        ['agitatorForward', 'AGITATOR_FORWARD'],
        ['agitatorReverse', 'AGITATOR_REVERSE'],
        ['heating', 'HEATING_ON'],
        ['exhaust', 'EXHAUST_ON'],
        ['reboot', 'REBOOT'],
        ['shutdown', 'SHUTDOWN'],
        ['modeSwitch', 'START'],
        ['factoryReset', 'FACTORY_RESET'],
      ]) {
        await page.getByTestId(`quick-${button}`).click();
        await expect(page.getByTestId('command-select')).toHaveValue(command!);
        if (['AGITATOR_FORWARD', 'AGITATOR_REVERSE', 'HEATING_ON', 'SHUTDOWN', 'FACTORY_RESET'].includes(command!)) {
          await expect(page.getByTestId('command-submit')).toBeDisabled();
          await page.getByTestId('command-confirm-text').fill('WRONG');
          await expect(page.getByTestId('command-submit')).toBeDisabled();
          await page.getByTestId('command-confirm-text').fill(command!);
          await expect(page.getByTestId('command-submit')).toBeEnabled();
        }
        await close(page);
      }
      expect(q.calls.some((c) => c.method === 'POST' && c.path.endsWith('/commands'))).toBe(false);
      q.guards.dangerousConfirmation = true;
      break;
    case 'device-operate.configuration':
      await page.getByTestId('goto-config-threshold').click();
      await expect(page).toHaveURL(/\/configurations$/);
      break;
    case 'device-operate.alias':
      await page.getByTestId('goto-alias').click();
      await page.getByTestId('alias-edit').click();
      await page.getByTestId('alias-input').fill(`${f.prefix}-EDITED`);
      await page.getByTestId('alias-save').click();
      await expect(page.getByTestId('alias-current')).toContainText(`${f.prefix}-EDITED`);
      expect(q.calls.find((c) => c.path.endsWith('/metadata'))?.body).toEqual({ alias: `${f.prefix}-EDITED` });
      f.device.alias = f.alias;
      await switchRole(page, 'CustomerAdmin');
      await go();
      await expect(page.getByTestId('goto-alias')).toHaveCount(0);
      await switchRole(page, 'PlatformSuperAdmin');
      q.guards.entryPermissions = true;
      break;
    case 'device-operate.activities':
      await columns(page, 'activity-table', ['时间', '级别', '内容']);
      await expect(page.getByTestId('activity-table')).toContainText(f.activity);
      await page.getByTestId('activity-filter-level').selectOption('INFO');
      await page.getByTestId('activity-filter-search').click();
      await expect
        .poll(() => q.calls.some((c) => c.path.endsWith('/activities') && c.query.level === 'INFO'))
        .toBe(true);
      await page.getByTestId('activity-export-csv').click();
      await expect(page.getByTestId('activity-export-download')).toHaveAttribute('href', '/fixture.csv');
      break;
    case 'device-group.filters':
      await page.getByTestId('device-keyword').fill(f.alias);
      await page.getByTestId('device-search').click();
      await expect.poll(() => q.calls.some((c) => c.query.keyword === f.alias)).toBe(true);
      await page.getByTestId('device-reset').click();
      await expect(page.getByTestId('device-keyword')).toHaveValue('');
      break;
    case 'device-group.columns':
      await columns(page, 'device-groups-page', [
        '序号',
        '设备区域',
        '设备子区域',
        '设备唯一ID',
        '设备别名',
        '关联合约名称',
        '租期期限',
        '软件版本',
      ]);
      for (const value of [f.region, f.subregion, f.serial, f.alias, f.contractName, f.firmware])
        await expect(page.getByTestId('device-groups-page')).toContainText(value);
      await expect(page.getByTestId(`seq-${f.deviceId}`)).toContainText('1');
      await axes(page, 'device-groups-page');
      q.guards.fourAxes = true;
      break;
    case 'device-group.manage':
      await page.getByTestId(`manage-${f.deviceId}`).click();
      await expect(page).toHaveURL(new RegExp('/devices/manage\\?deviceId=' + f.deviceId));
      await expect(page.getByTestId('device-manage-page')).toContainText(f.alias);
      break;
    case 'device-group.onboarding':
      await columns(page, 'onboarding-review', ['设备唯一ID（序列号）', '申请日期']);
      await expect(page.getByTestId('onboarding-review')).toContainText(f.request.serialNumber);
      await page.getByTestId(`detail-${f.requestId}`).click();
      await expect(page.getByTestId('request-detail')).toContainText(f.request.serialNumber);
      for (const action of ['approve-button', 'reject-button']) {
        await page.getByTestId(action).click();
        await expect(page.getByTestId('confirm-dialog')).toBeVisible();
        await close(page);
      }
      break;
    case 'device-manage.configuration':
      for (const button of ['goto-current-config', 'goto-publish-config']) {
        await go();
        await page.getByTestId(button).click();
        await expect(page).toHaveURL(/\/configurations$/);
        await page.getByTestId(`config-detail-open-${f.configId}`).click();
        await expect(page.getByTestId('config-detail')).toContainText(f.config.name);
        await page.getByTestId('config-publish-1').click();
        await expect(page.getByTestId('config-publish')).toBeEnabled();
        await close(page);
      }
      await switchRole(page, 'Auditor');
      await go();
      await expect(page.getByTestId('goto-current-config')).toBeVisible();
      await expect(page.getByTestId('goto-publish-config')).toHaveCount(0);
      await switchRole(page, 'CustomerViewer');
      await go();
      await expect(page.getByTestId('configuration-entry')).toHaveCount(0);
      await switchRole(page, 'PlatformSuperAdmin');
      q.guards.entryPermissions = true;
      break;
    case 'device-manage.ota':
      for (const [button, path] of [
        ['goto-ota-packages', '/ota/packages'],
        ['goto-ota-campaigns', '/ota/campaigns'],
      ]) {
        await go();
        await page.getByTestId(button!).click();
        await expect(page).toHaveURL(new RegExp(path! + '$'));
      }
      break;
    case 'device-manage.certificate':
      await expect(page.getByTestId('cert-id')).toHaveText(f.device.certificate.certificateId);
      await expect(page.getByTestId('cert-fingerprint')).toHaveText(f.device.certificate.fingerprint);
      await page.getByTestId('cert-rotate').click();
      await expect(page.getByTestId('rotation-result')).toContainText(`${f.prefix}-ROTATE`);
      expect(
        q.calls.filter((c) => c.path.endsWith('/certificate-rotation-requests') && c.method === 'POST'),
      ).toHaveLength(1);
      break;
    case 'device-manage.back':
      await page.getByTestId('manage-back').click();
      await expect(page).toHaveURL(/\/devices\/groups$/);
      break;
    case 'device-consumable.filters':
      await page.getByTestId('consumable-filter-keyword').fill(f.alias);
      await page.getByTestId('consumable-search').click();
      await expect.poll(() => q.calls.some((c) => c.query.keyword === f.alias)).toBe(true);
      await page.getByTestId('consumable-reset').click();
      await expect(page.getByTestId('consumable-filter-keyword')).toHaveValue('');
      break;
    case 'device-consumable.columns':
      await columns(page, 'consumable-table', [
        '设备区域',
        '设备子区域',
        '设备唯一ID',
        '设备别名',
        '碳包预估剩余百分比',
        '活性菌预估剩余百分比',
      ]);
      for (const value of [f.region, f.subregion, f.deviceId, f.alias])
        await expect(page.getByTestId('consumable-table')).toContainText(value);
      await expect(page.getByTestId(`consumable-carbon-${f.deviceId}`)).toContainText('31%');
      await expect(page.getByTestId(`consumable-bio-${f.deviceId}`)).toContainText('unknown');
      await expect(page.getByTestId(`consumable-bio-${f.deviceId}`).locator('.consumable-bar')).toHaveCount(0);
      q.guards.unknownNotInvented = true;
      break;
    case 'device-consumable.contact':
      expect(q.calls.some((c) => c.path.endsWith('/contact'))).toBe(false);
      await page.getByTestId(`consumable-contact-${f.deviceId}`).click();
      await expect(page.getByTestId(`consumable-contact-info-${f.deviceId}`)).toContainText(f.phone);
      break;
    case 'device-consumable.requests':
      await columns(page, 'consumable-requests-table', ['用户申请时间', '处理状态']);
      await expect(page.getByTestId(`consumable-request-status-${f.requestId}`)).toContainText('待处理');
      for (const action of ['process', 'complete']) {
        if (action === 'complete') {
          await page.route('**/api/v1/admin/consumable-requests**', async (route) => {
            if (route.request().method() === 'GET')
              return route.fulfill({
                json: {
                  data: [
                    {
                      ...f.request,
                      requestId: f.requestId,
                      deviceId: f.deviceId,
                      customerId: f.customerId,
                      consumableType: 'CARBON_FILTER',
                      status: 'PROCESSING',
                      requestedAt: f.at,
                      version: 1,
                    },
                  ],
                },
              });
            return route.fallback();
          });
          await go();
        }
        await page.getByTestId(`consumable-${action}-${f.requestId}`).click();
        await expect(page.getByTestId('consumable-action-submit')).toBeVisible();
        await close(page);
      }
      break;
    case 'contract-modify.columns':
      await columns(page, 'contract-list', ['合约编号', '客户', '设备数量', '服务期限', '状态（合约）']);
      await expect(page.getByTestId('contract-list')).toContainText(f.contractNumber);
      await expect(page.getByTestId('contract-list')).toContainText(f.customer);
      await expect(page.getByTestId(`contract-device-count-${f.contractId}`)).toHaveText('1');
      await expect(page.getByTestId(`contract-status-${f.contractId}`)).toContainText('生效');
      break;
    case 'contract-modify.new':
      await page.getByTestId('contract-new-open').click();
      await expect(page).toHaveURL(/\/contracts\/new$/);
      break;
    case 'contract-modify.detail':
      await page.getByTestId(`contract-open-${f.contractId}`).click();
      await expect(page.getByTestId('contract-devices-table')).toContainText(f.deviceId);
      await page.getByTestId('contract-edit-open').click();
      await expect(page.getByTestId('contract-edit-name')).toHaveValue(f.contractName);
      await close(page);
      await page.getByTestId('contract-renew-open').click();
      await expect(page.getByTestId('contract-renew-submit')).toBeDisabled();
      await close(page);
      await page.getByTestId(`contract-unbind-check-${f.deviceId}`).check();
      await page.getByTestId('contract-unbind-open').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await close(page);
      break;
    case 'contract-new.fields':
      await page.getByTestId('contract-number-input').fill(f.contractNumber);
      await page.getByTestId('contract-name-input').fill(f.contractName);
      await page.getByTestId('contract-customer-select').selectOption(f.customerId);
      await page.getByTestId('contract-start-input').fill('2026-10-01T00:00');
      await page.getByTestId('contract-end-input').fill('2027-10-01T00:00');
      await expect(page.getByTestId('contract-create-submit')).toBeEnabled();
      break;
    case 'contract-new.submit':
      await page.getByTestId('contract-number-input').fill(f.contractNumber);
      await page.getByTestId('contract-name-input').fill(f.contractName);
      await page.getByTestId('contract-customer-select').selectOption(f.customerId);
      await page.getByTestId('contract-start-input').fill('2026-10-01T00:00');
      await page.getByTestId('contract-end-input').fill('2027-10-01T00:00');
      await page.getByTestId('contract-create-submit').click();
      await expect(page.getByTestId(`contract-new-device-${f.deviceId}`)).toBeVisible();
      await expect(page.getByTestId('contract-new-done')).toBeDisabled();
      await page.getByTestId(`contract-new-device-${f.deviceId}`).check();
      await page.getByTestId('contract-bind-reason').fill(f.prefix);
      await page.getByTestId('contract-bind-submit').click();
      await expect(page.getByTestId('contract-new-done')).toBeEnabled();
      break;
    case 'contract-new.cancel':
      await page.getByTestId('contract-create-cancel').click();
      await expect(page).toHaveURL(/\/contracts$/);
      break;
    case 'contract-detail.devices':
      await columns(page, 'contract-devices-table', [
        '区域',
        '子区域',
        '唯一 ID',
        '别名',
        '软件版本',
        '四轴状态',
        '授权状态（License，独立）',
      ]);
      for (const value of [f.region, f.subregion, f.deviceId, f.alias, f.firmware])
        await expect(page.getByTestId('contract-devices-table')).toContainText(value);
      await axes(page, 'contract-devices-table');
      q.guards.fourAxes = true;
      break;
    case 'contract-detail.back':
      await page.getByTestId('contract-detail-back').click();
      await expect(page).toHaveURL(/\/contracts$/);
      break;
    case 'esg-overview.period':
    case 'esg-device.period':
      for (const period of ['day', 'week', 'month']) {
        const id = key.startsWith('esg-device') ? 'esg-device-period-' : 'period-';
        await page.getByTestId(id + period).click();
        await expect(page.getByTestId(id + period)).toHaveAttribute('aria-pressed', 'true');
      }
      break;
    case 'esg-overview.columns':
      await columns(page, 'esg-summary-table', ['日期间', '投料量 (kg)', '能耗 (kWh)', '估算 CO2e (kg)']);
      await expect(page.getByTestId('esg-summary-table')).toContainText(String(f.n));
      await expect(page.getByTestId('esg-disclaimer')).toContainText('估算');
      break;
    case 'esg-overview.export':
    case 'esg-device.export': {
      const prefix = key.startsWith('esg-device') ? 'esg-device' : 'esg';
      await page.getByTestId(prefix + '-export-csv').click();
      await expect(page.getByTestId(prefix + '-export-download')).toHaveAttribute('href', '/fixture.csv');
      break;
    }
    case 'esg-device.metrics':
      await columns(page, 'esg-device-metrics', [
        '投料 (kg)',
        '出料 (kg)',
        '减量 (kg)',
        '能耗 (kWh)',
        'O2 (%)',
        'CO2 (ppm)',
        'CH4 (ppm)',
        'N2O (ppm)',
        '估算 CO2e (kg)',
      ]);
      await expect(page.getByTestId('esg-device-metrics')).toContainText(String(f.n));
      break;
    case 'settings.platform':
      await page.getByTestId('user-invite-open').click();
      await expect(page.getByTestId('invite-email')).toBeVisible();
      await expect(page.getByRole('dialog').locator('input[type="password"]')).toHaveCount(0);
      await close(page);
      for (const action of ['reset', 'disable']) {
        await page.getByTestId(`user-${action}-${f.userId}`).click();
        await expect(page.getByTestId('confirm-dialog')).toBeVisible();
        await close(page);
      }
      q.guards.noPlatformPassword = true;
      break;
    case 'settings.device-users':
      await page.getByTestId('tab-device-users').click();
      await page.getByTestId('device-user-keyword').fill(f.prefix);
      await page.getByTestId('device-user-search').click();
      await expect
        .poll(() => q.calls.some((c) => c.path.endsWith('/device-users') && c.query.keyword === f.prefix))
        .toBe(true);
      await page.getByTestId('device-user-filter-reset').click();
      await expect(page.getByTestId('device-user-keyword')).toHaveValue('');
      await page.getByTestId('device-user-create').click();
      await expect(page.getByTestId('create-password')).toBeVisible();
      await close(page);
      await page.getByTestId(`device-user-detail-${f.deviceUserId}`).click();
      for (const action of ['password-reset', 'disable']) {
        await page.getByTestId(`device-user-${action}`).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await close(page);
      }
      break;
    default:
      throw Error(`UNBOUND_ASSERTION ${key}`);
  }
  q.groups.push(key);
}
for (const width of VIEWPORTS)
  for (const p of matrix.pages)
    test(`QA08 ${p.pageState} ${width}`, async ({ page, qa08: q }) => {
      await page.setViewportSize({ width, height: 1000 });
      const go = async () => {
        const query =
          p.pageState === 'device-manage'
            ? `?deviceId=${q.f.deviceId}`
            : p.pageState === 'contract-detail'
              ? `?contractId=${q.f.contractId}`
              : '';
        await page.goto(p.routeId + query);
        await expect(page.getByTestId(roots[p.pageState]!)).toBeVisible();
        await page.waitForLoadState('networkidle');
        if (['device-view', 'device-operate', 'esg-device'].includes(p.pageState))
          await scope(
            page,
            q,
            p.pageState === 'device-view'
              ? 'view-apply'
              : p.pageState === 'esg-device'
                ? 'esg-device-apply'
                : undefined,
          );
        await page.waitForLoadState('networkidle');
      };
      await go();
      const menu = matrix.menus.find((m: any) => m.pageState === p.pageState);
      if (menu) {
        if (width === 375) await page.getByTestId('drawer-open').click();
        await expect(page.getByTestId(`menu-item-${menu.routeId}`)).toBeVisible();
        await page.getByTestId(`menu-item-${menu.routeId}`).click();
        await expect(page).toHaveURL(new RegExp(menu.routeId + '$'));
        q.menus.push(menu.menuId);
        await go();
      }
      if (width === 375) {
        await page.getByTestId('drawer-open').click();
        await expect(page.getByTestId('sidebar')).toHaveClass(/open/);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('sidebar')).not.toHaveClass(/open/);
        await expect(page.getByTestId('drawer-open')).toBeFocused();
      } else {
        await expect(page.getByTestId('sidebar')).toBeVisible();
      }
      q.guards.responsiveSidebar = true;
      await expect.poll(() => layoutViolations(page)).toEqual([]);
      q.guards.noClipping = true;
      await q.snapshot(page, p.pageState, width);
      for (const [id, original] of Object.entries(ABSENCE).filter(([id]) => id.startsWith(p.pageState + '.'))) {
        if (id === 'settings.modal.passwordInput') {
          await page.getByTestId('user-invite-open').click();
          await expect(page.getByRole('dialog').locator('input[type="password"]')).toHaveCount(0);
          await close(page);
        } else if (id === 'settings.field.permissionCheckboxes') {
          const boxes = page.locator('input[data-testid^="rbac-"]');
          expect(await boxes.count()).toBeGreaterThan(0);
          for (const box of await boxes.all()) await expect(box).toBeDisabled();
          await go();
        } else {
          await expect(
            page.getByTestId('page-content').getByRole('button', { name: new RegExp(original) }),
          ).toHaveCount(0);
          await expect(
            page.getByTestId('page-content').getByRole('columnheader', { name: new RegExp(original) }),
          ).toHaveCount(0);
        }
        q.absence.push(id);
      }
      for (const key of Object.keys(GROUPS).filter((k) => k.startsWith(p.pageState + '.')))
        await checkGroup(key, page, q, go);
      await go();
      await expect(page.getByTestId('page-content')).not.toContainText(`${q.prefix}-UNMAPPED`);
      if (['device-view', 'device-operate'].includes(p.pageState))
        await expect(page.getByTestId('page-content').locator('video')).toHaveCount(0);
      q.guards.unmappedFieldIgnored = true;
    });
