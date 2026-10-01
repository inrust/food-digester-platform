export const VIEWPORTS = [375, 1440];
export const GROUPS = {
  'dashboard.summary': [
    'dashboard.field.validContracts',
    'dashboard.field.deviceStats',
    'dashboard.field.onlineRate',
    'dashboard.field.carbonToday',
  ],
  'dashboard.collections': ['dashboard.field.latestAlarms', 'dashboard.field.deviceCards'],
  'dashboard.commands': ['dashboard.button.start', 'dashboard.button.stop', 'dashboard.button.reboot'],
  'dashboard.upgrade': ['dashboard.button.upgrade'],
  'device-view.scope': [
    'device-view.filter.region',
    'device-view.filter.subregion',
    'device-view.filter.device',
    'device-view.button.apply',
  ],
  'device-view.console': [
    'device-view.field.componentStates',
    'device-view.field.sensorReadings',
    'device-view.field.consumables',
    'device-view.field.recentAlarms',
    'device-view.field.esg7d',
  ],
  'device-view.media': ['device-view.field.mediaPreview'],
  'device-operate.commands': [
    'device-operate.button.agitatorForward',
    'device-operate.button.agitatorReverse',
    'device-operate.button.heating',
    'device-operate.button.exhaust',
    'device-operate.button.reboot',
    'device-operate.button.shutdown',
    'device-operate.button.modeSwitch',
    'device-operate.button.factoryReset',
  ],
  'device-operate.configuration': ['device-operate.button.updateThreshold'],
  'device-operate.alias': ['device-operate.button.saveAlias'],
  'device-operate.activities': [
    'device-operate.table.activityLog',
    'device-operate.button.logFilter',
    'device-operate.button.logExport',
  ],
  'device-group.filters': ['device-group.button.search', 'device-group.button.reset'],
  'device-group.columns': [
    'device-group.column.seq',
    'device-group.column.region',
    'device-group.column.subregion',
    'device-group.column.deviceId',
    'device-group.column.alias',
    'device-group.column.contractName',
    'device-group.column.leaseTerm',
    'device-group.column.firmware',
    'device-group.field.fourAxisStatus',
  ],
  'device-group.manage': ['device-group.column.actions'],
  'device-group.onboarding': [
    'device-group.req.column.deviceId',
    'device-group.req.column.requestDate',
    'device-group.req.button.detail',
    'device-group.req.button.accept',
    'device-group.req.button.reject',
  ],
  'device-manage.configuration': [
    'device-manage.button.updateConfig',
    'device-manage.button.viewConfig',
    'device-manage.button.confirm',
  ],
  'device-manage.ota': ['device-manage.button.selectFirmware', 'device-manage.button.syncUpdate'],
  'device-manage.certificate': ['device-manage.button.certDetail', 'device-manage.button.issueCert'],
  'device-manage.back': ['device-manage.button.back'],
  'device-consumable.filters': ['device-consumable.button.search', 'device-consumable.button.reset'],
  'device-consumable.columns': [
    'device-consumable.column.region',
    'device-consumable.column.subregion',
    'device-consumable.column.deviceId',
    'device-consumable.column.alias',
    'device-consumable.column.carbonFilterPct',
    'device-consumable.column.bioAdditivePct',
  ],
  'device-consumable.contact': ['device-consumable.button.contact'],
  'device-consumable.requests': [
    'device-consumable.req.column.requestTime',
    'device-consumable.req.column.status',
    'device-consumable.req.button.process',
    'device-consumable.req.button.complete',
  ],
  'contract-modify.columns': [
    'contract-modify.column.contractNumber',
    'contract-modify.column.customer',
    'contract-modify.column.deviceCount',
    'contract-modify.column.servicePeriod',
    'contract-modify.column.status',
  ],
  'contract-modify.new': ['contract-modify.button.new'],
  'contract-modify.detail': [
    'contract-modify.button.edit',
    'contract-modify.button.renewOrUnbind',
    'contract-modify.button.queryDevices',
  ],
  'contract-new.fields': [
    'contract-new.field.number',
    'contract-new.field.name',
    'contract-new.field.customer',
    'contract-new.field.period',
  ],
  'contract-new.submit': ['contract-new.field.devices', 'contract-new.button.submit'],
  'contract-new.cancel': ['contract-new.button.cancel'],
  'contract-detail.devices': [
    'contract-detail.column.region',
    'contract-detail.column.subregion',
    'contract-detail.column.deviceId',
    'contract-detail.column.alias',
    'contract-detail.field.fourAxisStatus',
    'contract-detail.column.firmware',
    'contract-detail.field.licenseSummary',
  ],
  'contract-detail.back': ['contract-detail.button.back'],
  'esg-overview.period': ['esg-overview.toggle.period'],
  'esg-overview.columns': [
    'esg-overview.column.date',
    'esg-overview.column.carbon',
    'esg-overview.column.throughput',
    'esg-overview.column.energy',
  ],
  'esg-overview.export': ['esg-overview.button.exportCsv'],
  'esg-device.scope': [
    'esg-device.filter.region',
    'esg-device.filter.subregion',
    'esg-device.filter.device',
    'esg-device.button.apply',
  ],
  'esg-device.period': ['esg-device.toggle.period'],
  'esg-device.metrics': ['esg-device.field.metrics'],
  'esg-device.export': ['esg-device.button.exportCsv'],
  'settings.platform': [
    'settings.button.addPlatformUser',
    'settings.button.resetPlatformUserPassword',
    'settings.button.deletePlatformUser',
    'settings.modal.confirm',
  ],
  'settings.device-users': [
    'settings.button.addDeviceUser',
    'settings.button.deviceUserFilter',
    'settings.button.deviceUserFilterReset',
    'settings.button.resetDeviceUserPassword',
    'settings.button.deleteDeviceUser',
  ],
};
// Defer/Reject means asserting the original feature is absent, not asserting it is implemented.
export const ABSENCE = {
  'device-view.button.camPlay': '摄像头播放|实时播放|播放摄像头',
  'device-view.button.camStop': '摄像头停止|停止播放|停止摄像头',
  'device-operate.button.updateStrategy': '更新策略',
  'device-operate.button.camPlay': '摄像头播放|实时播放|播放摄像头',
  'device-operate.button.camStop': '摄像头停止|停止播放|停止摄像头',
  'device-group.column.enabledFlag': '是否启用',
  'device-group.column.enabledStatus': '启用状态',
  'device-group.req.column.creator': '录入人',
  'contract-detail.column.enabledStatus': '启用状态',
  'settings.field.permissionCheckboxes': '自由权限复选框',
  'settings.modal.passwordInput': '平台明文密码',
};
export function validateBindings(matrix, groups = GROUPS, absence = ABSENCE) {
  const elements = matrix.pages.flatMap((p) => p.elements),
    positive = elements.filter((e) => ['Adopt', 'Adapt'].includes(e.disposition)),
    negative = elements.filter((e) => ['Defer', 'Reject'].includes(e.disposition));
  const bound = Object.values(groups).flat();
  if (
    bound.length !== positive.length ||
    new Set(bound).size !== bound.length ||
    positive.some((e) => !bound.includes(e.id)) ||
    bound.some((id) => !positive.some((e) => e.id === id))
  )
    throw Error('INCOMPLETE_POSITIVE_BINDINGS');
  if (
    Object.keys(absence).length !== negative.length ||
    negative.some((e) => !absence[e.id]) ||
    Object.keys(absence).some((id) => !negative.some((e) => e.id === id))
  )
    throw Error('INCOMPLETE_ABSENCE_BINDINGS');
  for (const [key, ids] of Object.entries(groups))
    if (!ids.length || ids.some((id) => !id.startsWith(`${key.split('.')[0]}.`))) throw Error('BINDING_PAGE_MISMATCH');
  return {
    menus: matrix.menus.length,
    pages: matrix.pages.length,
    positive: positive.length,
    negative: negative.length,
    groups: Object.keys(groups).length,
  };
}
