/**
 * BE-DEV-05 Admin Device Console OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-device-console-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-device-console-api.json', import.meta.url), 'utf8'));
const base = JSON.parse(readFileSync(new URL('./openapi-base.json', import.meta.url), 'utf8'));

function resolvePointer(root: unknown, pointer: string): unknown {
  let node = root as Record<string, unknown> | undefined;
  for (const seg of pointer.slice(2).split('/')) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')] as Record<string, unknown> | undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) out.push(...node.flatMap((item) => collectRefs(item)));
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

test('端点齐备且 CognitoJwt 认证：console/activities/export/导出详情', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expectations: Array<[string, string, string, string[]]> = [
    ['/api/v1/admin/devices/{deviceId}/console', 'get', 'getDeviceConsole', ['200', '401', '403', '404']],
    ['/api/v1/admin/devices/{deviceId}/activities', 'get', 'listDeviceActivities', ['200', '400', '401', '403', '404']],
    [
      '/api/v1/admin/devices/{deviceId}/activities/export',
      'post',
      'createActivityExport',
      ['202', '400', '401', '403', '404'],
    ],
    ['/api/v1/admin/activity-exports/{exportId}', 'get', 'getActivityExport', ['200', '401', '403', '404']],
  ];
  for (const [path, method, operationId, codes] of expectations) {
    const op = doc.paths[path]?.[method];
    assert.ok(op, `缺少端点 ${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }], `${operationId} 必须 CognitoJwt`);
    for (const code of codes) assert.ok(op.responses[code], `${operationId} 缺少响应码 ${code}`);
  }
  // 导出为异步：不存在同步 CSV 下载路由；console 只读
  assert.deepEqual(Object.keys(doc.paths['/api/v1/admin/devices/{deviceId}/console']), ['get']);
});

test('四轴分离 + 数据块 observedAt/stale/单位；最新 Media 可选块稳定可空', () => {
  const device = doc.components.schemas.DeviceConsoleView.properties.device;
  for (const axis of ['lifecycleStatus', 'operationalStatus', 'connectivity', 'licenseStatus']) {
    assert.ok(device.required.includes(axis), `四轴字段 ${axis} 必须独立存在`);
  }
  assert.ok(!('enabled' in device.properties), 'DEC-010：不得合并派生 enabled 单字段');

  // 数据块携带 observedAt + stale（metrics 为 $ref，需解析后检查）
  for (const block of ['components', 'metrics', 'network']) {
    let schema = doc.components.schemas.DeviceConsoleView.properties[block];
    if (schema.$ref) schema = resolvePointer(doc, schema.$ref.slice(schema.$ref.indexOf('#')));
    assert.ok(
      schema.required.includes('observedAt') && schema.required.includes('stale'),
      `${block} 必须携带 observedAt/stale`,
    );
  }
  // 遥测指标带单位
  assert.ok(doc.components.schemas.MetricValue.required.includes('unit'));
  // 耗材携带 observedAt + stale
  const consumable = doc.components.schemas.DeviceConsoleView.properties.consumables.items;
  assert.ok(consumable.required.includes('observedAt') && consumable.required.includes('stale'));
  // 最新 Media 可空（未启用稳定 null）
  const media = doc.components.schemas.DeviceConsoleView.properties.latestMedia;
  assert.ok(JSON.stringify(media.anyOf).includes('"null"'), 'latestMedia 必须可空');

  // 活动级别：EVENT 固定 INFO 的派生语义声明
  assert.ok(doc.components.schemas.ActivityItem.properties.level.description.includes('EVENT'));
});

test('不透传 MQTT 原始消息、不含实时流/运维字段；所有 $ref 可解析', () => {
  const json = JSON.stringify(doc.components.schemas).toLowerCase();
  for (const forbidden of ['rawpayload', 'mqtt', 'videostream', 'payloadhash']) {
    assert.ok(!json.includes(forbidden), `DTO 不得包含 ${forbidden}`);
  }
  const refs = collectRefs(doc);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const hashIdx = ref.indexOf('#');
    const targetFile = hashIdx > 0 ? ref.slice(0, hashIdx) : null;
    const pointer = ref.slice(hashIdx);
    const targetDoc = targetFile === null ? doc : targetFile === 'openapi-base.json' ? base : undefined;
    assert.ok(targetDoc, `$ref 目标文件不允许: ${ref}`);
    assert.notEqual(resolvePointer(targetDoc, pointer), undefined, `悬空引用: ${ref}`);
  }
});
