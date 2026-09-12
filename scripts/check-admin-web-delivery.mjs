#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function operationIds(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => operationIds(item, found));
  else if (value && typeof value === 'object') {
    if (typeof value.operationId === 'string') found.add(value.operationId);
    Object.values(value).forEach((item) => operationIds(item, found));
  }
  return found;
}

const REQUIRED_TASKS = Array.from({ length: 19 }, (_, index) => `FE-${String(index + 1).padStart(2, '0')}`);
const REQUIRED_P0_ROUTES = new Map([
  ['/devices/view', { pageState: 'device-view', controller: 'DeviceViewController', testId: 'device-view-page' }],
  [
    '/devices/manage',
    { pageState: 'device-manage', controller: 'DeviceManageController', testId: 'device-manage-page' },
  ],
  ['/licenses', { pageState: 'licenses', controller: 'LicensesController', testId: 'licenses-page' }],
  [
    '/configurations',
    { pageState: 'configurations', controller: 'ConfigurationsController', testId: 'configurations-page' },
  ],
  ['/device-users', { pageState: 'device-users', controller: 'DeviceUsersController', testId: 'device-users-page' }],
  ['/alarms', { pageState: 'alarms', controller: 'AlarmsController', testId: 'alarms-page' }],
  ['/esg/overview', { pageState: 'esg-overview', controller: 'EsgOverviewController', testId: 'esg-overview-page' }],
  ['/esg/devices', { pageState: 'esg-device', controller: 'EsgDevicesController', testId: 'esg-devices-page' }],
  [
    '/devices/operate',
    { pageState: 'device-operate', controller: 'DeviceOperateController', testId: 'device-operate-page' },
  ],
  [
    '/ota/campaigns',
    { pageState: 'ota-campaigns', controller: 'OtaCampaignsController', testId: 'ota-campaigns-page' },
  ],
  ['/ota/packages', { pageState: 'ota-packages', controller: 'OtaPackagesController', testId: 'ota-packages-page' }],
  ['/media', { pageState: 'media', controller: 'MediaController', testId: 'media-page' }],
  ['/audit-logs', { pageState: 'audit-logs', controller: 'AuditLogsController', testId: 'audit-logs-page' }],
  ['/settings', { pageState: 'settings', controller: 'SettingsController', testId: 'settings-page' }],
  ['/contracts', { pageState: 'contract-modify', controller: 'ContractsController', testId: 'contracts-page' }],
  ['/contracts/new', { pageState: 'contract-new', controller: 'ContractNewController', testId: 'contract-new-page' }],
  [
    '/contracts/detail',
    { pageState: 'contract-detail', controller: 'ContractDetailController', testId: 'contract-detail-page' },
  ],
  ['/consumables', { pageState: 'device-consumable', controller: 'ConsumablesController', testId: 'consumables-page' }],
]);
const REQUIRED_P0_OPERATIONS = [
  'listDevices',
  'getDevice',
  'getDeviceConsole',
  'listDeviceActivities',
  'listMedia',
  'createMediaDownloadUrl',
  'listDeviceAssignments',
  'assignDevice',
  'suspendDevice',
  'reactivateDevice',
  'retireDevice',
  'forceCompleteRetirement',
  'updateDeviceMetadata',
  'createCertificateRotationRequest',
  'createLicense',
  'listLicenses',
  'getLicense',
  'listLicenseHistory',
  'issueLicense',
  'activateLicense',
  'renewLicense',
  'revokeLicense',
  'listConfigurations',
  'createConfiguration',
  'getConfiguration',
  'createConfigurationVersion',
  'publishConfigurationVersion',
  'getConfigurationVersionStatus',
  'listDeviceUsers',
  'createDeviceUser',
  'getDeviceUser',
  'updateDeviceUser',
  'disableDeviceUser',
  'assignDeviceUser',
  'revokeDeviceUser',
  'listAlarms',
  'getAlarm',
  'acknowledgeAlarm',
  'clearAlarm',
  'listDeviceEvents',
  'listTamperEvents',
  'listEsgDailySummary',
  'listEsgReports',
  'listEsgCalculationVersions',
  'createEsgExport',
  'getEsgExport',
  'listCommands',
  'getCommand',
  'createActivityExport',
  'getActivityExport',
  'createFirmwareUpload',
  'completeFirmwareUpload',
  'listFirmwarePackages',
  'createOtaCampaign',
  'listOtaCampaigns',
  'getOtaCampaign',
  'listOtaTargets',
  'expandOtaCampaignBatch',
  'pauseOtaCampaign',
  'resumeOtaCampaign',
  'cancelOtaCampaign',
  'retryOtaCampaignFailures',
  'listAuditLogs',
  'getAuditLogDetail',
  'listUsers',
  'inviteUser',
  'assignUserRoles',
  'setUserScope',
  'disableUser',
  'triggerUserPasswordReset',
  'listSettings',
  'getSetting',
  'updateSetting',
  'createContract',
  'listContracts',
  'getContract',
  'updateContract',
  'activateContract',
  'renewContract',
  'terminateContract',
  'evaluateContract',
  'listContractDevices',
  'listAvailableDevices',
  'listContractAssociations',
  'bindContractDevices',
  'unbindContractDevices',
  'listConsumableStatus',
  'createConsumableRequest',
  'listConsumableRequests',
  'getConsumableRequest',
  'processConsumableRequest',
  'completeConsumableRequest',
  'cancelConsumableRequest',
];

function implementedPageStates(appSource) {
  const match = appSource.match(/IMPLEMENTED_PAGE_STATES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  return new Set(match?.[1].match(/'([^']+)'/g)?.map((value) => value.slice(1, -1)) ?? []);
}

export function auditAdminWebDelivery(root, options = {}) {
  const errors = [];
  const appRoot = join(root, 'apps/admin-web');
  const requiredFiles = [
    'index.html',
    'vite.config.ts',
    'src/main.tsx',
    'src/app/App.tsx',
    'src/app/composition-root.ts',
    'src/app/controllers.tsx',
    'src/app/feature-controllers.tsx',
    'src/app/operations-controllers.tsx',
    'src/app/LoginPage.tsx',
    'src/app/app.css',
    'test/app-smoke.test.tsx',
  ];
  for (const file of requiredFiles) {
    if (!existsSync(join(appRoot, file))) errors.push(`缺少浏览器运行文件：${file}`);
  }

  const packagePath = join(appRoot, 'package.json');
  if (existsSync(packagePath)) {
    const scripts = readJson(packagePath).scripts ?? {};
    for (const name of ['dev', 'build', 'start']) {
      if (typeof scripts[name] !== 'string' || !scripts[name].includes('vite'))
        errors.push(`package.json 缺少可运行 ${name} 脚本`);
    }
  } else errors.push('缺少 apps/admin-web/package.json');

  const manifestPath = join(appRoot, 'admin-web-delivery-manifest.json');
  const routesPath = join(appRoot, 'src/router/routes.ts');
  const appPath = join(appRoot, 'src/app/App.tsx');
  const openapiPath = join(root, 'contracts/rest/openapi.bundle.json');
  const manifest = existsSync(manifestPath) ? (options.manifestOverride ?? readJson(manifestPath)) : null;
  if (manifest === null) errors.push('缺少管理后台交付清单');
  else {
    const routesSource =
      options.routesSourceOverride ?? (existsSync(routesPath) ? readFileSync(routesPath, 'utf8') : '');
    const appSource = options.appSourceOverride ?? (existsSync(appPath) ? readFileSync(appPath, 'utf8') : '');
    const controllerSource =
      options.controllerSourceOverride ??
      [
        'src/app/controllers.tsx',
        'src/app/feature-controllers.tsx',
        'src/app/operations-controllers.tsx',
        'src/app/business-controllers.tsx',
      ]
        .map((file) => (existsSync(join(appRoot, file)) ? readFileSync(join(appRoot, file), 'utf8') : ''))
        .join('\n');
    if (manifest.schemaVersion !== 4 || manifest.deliveryScope !== 'FE-01..FE-19')
      errors.push('管理后台交付清单版本或范围不是 FE-01..FE-19/v4');
    const tasks = new Set(manifest.tasks ?? []);
    for (const task of REQUIRED_TASKS) if (!tasks.has(task)) errors.push(`交付清单缺少任务：${task}`);
    const manifestRoutes = new Map((manifest.routes ?? []).map((route) => [route.path, route]));
    for (const [path, required] of REQUIRED_P0_ROUTES) {
      const route = manifestRoutes.get(path);
      if (route === undefined) errors.push(`交付清单缺少 P0 路由：${path}`);
      else
        for (const key of ['pageState', 'controller', 'testId']) {
          if (route[key] !== required[key]) errors.push(`P0 路由事实不匹配：${path}.${key}`);
        }
    }
    for (const route of manifest.routes ?? []) {
      if (!routesSource.includes(`path: '${route.path}'`) && !routesSource.includes(route.path))
        errors.push(`路由未注册：${route.path}`);
      if (
        route.pageState !== 'login' &&
        route.pageState !== 'forbidden' &&
        !appSource.includes(`case '${route.pageState}':`)
      )
        errors.push(`路由无显式页面分支：${route.pageState}`);
      if (typeof route.controller === 'string' && !controllerSource.includes(`export function ${route.controller}`))
        errors.push(`路由控制器未交付：${route.controller}`);
    }
    const implemented = implementedPageStates(appSource);
    const declared = new Set((manifest.routes ?? []).map((route) => route.pageState));
    for (const state of implemented) if (!declared.has(state)) errors.push(`已实现页面未登记交付清单：${state}`);
    for (const state of declared)
      if (!implemented.has(state)) errors.push(`交付清单页面未列入 IMPLEMENTED_PAGE_STATES：${state}`);
    if (!existsSync(openapiPath)) errors.push('缺少 bundled OpenAPI');
    else {
      const delivered = operationIds(readJson(openapiPath));
      const declaredOperations = new Set(manifest.operationIds ?? []);
      for (const id of REQUIRED_P0_OPERATIONS)
        if (!declaredOperations.has(id)) errors.push(`交付清单缺少 P0 operationId：${id}`);
      for (const id of declaredOperations) {
        if (!delivered.has(id)) errors.push(`OpenAPI operationId 未交付：${id}`);
      }
    }
  }

  const mainSource = existsSync(join(appRoot, 'src/main.tsx'))
    ? readFileSync(join(appRoot, 'src/main.tsx'), 'utf8')
    : '';
  if (!mainSource.includes("'./shell/shell.css'") || !mainSource.includes("'./app/app.css'"))
    errors.push('浏览器入口未装载壳层与页面 CSS');

  if (options.requireBuild !== false) {
    const webDist = join(appRoot, 'dist/web');
    const assets = join(webDist, 'assets');
    if (!existsSync(join(webDist, 'index.html'))) errors.push('缺少 dist/web/index.html 浏览器构建产物');
    if (!existsSync(assets)) errors.push('缺少 dist/web/assets 构建产物');
    else {
      const files = readdirSync(assets);
      if (!files.some((file) => file.endsWith('.js'))) errors.push('浏览器构建产物缺少 JavaScript bundle');
      if (!files.some((file) => file.endsWith('.css'))) errors.push('浏览器构建产物缺少 CSS bundle');
      for (const file of files.filter((name) => name.endsWith('.js'))) {
        const source = readFileSync(join(assets, file), 'utf8');
        if (source.includes('__vite-browser-external') || source.includes('PrismaClient')) {
          errors.push(`浏览器 bundle 混入 Node/数据库依赖：${file}`);
        }
      }
      const browserSource = files
        .filter((name) => name.endsWith('.js'))
        .map((file) => readFileSync(join(assets, file), 'utf8'))
        .join('\n');
      for (const route of manifest?.routes ?? []) {
        if (typeof route.testId === 'string' && !browserSource.includes(route.testId))
          errors.push(`浏览器构建产物缺少页面标识：${route.testId}`);
      }
    }
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const errors = auditAdminWebDelivery(root);
  if (errors.length > 0) {
    errors.forEach((error) => console.error(`管理后台交付阻断：${error}`));
    process.exitCode = 1;
    return;
  }
  console.log('管理后台交付检查通过：入口、组合根、路由页面、OpenAPI operationId、CSS 与浏览器构建产物均已就绪');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
