/**
 * BE-ALM-01 Admin Alarm/Event/Tamper OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-alarm-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-alarm-api.json', import.meta.url), 'utf8'));
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
  if (Array.isArray(node)) node.forEach((item) => collectRefs(item, out));
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

test('六个端点齐备且 CognitoJwt 认证；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected = [
    ['/api/v1/admin/alarms', 'get', ['200', '400', '401', '403', '500']],
    ['/api/v1/admin/alarms/{alarmId}', 'get', ['200', '401', '403', '404', '500']],
    ['/api/v1/admin/alarms/{alarmId}/acknowledge', 'post', ['200', '400', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/alarms/{alarmId}/clear', 'post', ['200', '400', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/events', 'get', ['200', '400', '401', '403', '500']],
    ['/api/v1/admin/tamper-events', 'get', ['200', '400', '401', '403', '500']],
  ] as const;
  for (const [path, method, statuses] of expected) {
    const op = doc.paths[path][method];
    assert.ok(op, `缺少 ${method.toUpperCase()} ${path}`);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
    for (const status of statuses) assert.ok(op.responses[status], `${path} 缺少 ${status}`);
  }
  assert.equal(doc.paths['/api/v1/admin/alarms'].get.operationId, 'listAlarms');
  assert.equal(doc.paths['/api/v1/admin/alarms/{alarmId}/acknowledge'].post.operationId, 'acknowledgeAlarm');
  assert.equal(doc.paths['/api/v1/admin/alarms/{alarmId}/clear'].post.operationId, 'clearAlarm');
});

test('筛选参数齐备：severity/status/device/site/时间范围 + 游标分页', () => {
  const paramNames = (params: { name?: string; $ref?: string }[]) => params.map((p) => p.name ?? p.$ref);
  const alarmParams = paramNames(doc.paths['/api/v1/admin/alarms'].get.parameters);
  for (const name of ['customerId', 'siteId', 'deviceId', 'severity', 'status', 'from', 'to']) {
    assert.ok(alarmParams.includes(name), `alarms 列表缺少 ${name}`);
  }
  assert.equal(
    alarmParams.filter((p) => typeof p === 'string' && p.includes('Cursor')).length,
    1,
    'alarms 列表缺少 Cursor',
  );
  const tamperParams = paramNames(doc.paths['/api/v1/admin/tamper-events'].get.parameters);
  for (const name of ['customerId', 'siteId', 'deviceId', 'eventType', 'severity', 'from', 'to']) {
    assert.ok(tamperParams.includes(name), `tamper-events 列表缺少 ${name}`);
  }
});

test('Schema 封闭：Alarm 处理字段（操作者/原因/时间）与 replayed 齐备；确认/清除强制 reason', () => {
  const alarm = doc.components.schemas.Alarm;
  for (const field of [
    'acknowledgedBy',
    'acknowledgedAt',
    'acknowledgeReason',
    'clearedBy',
    'clearedAt',
    'clearReason',
  ]) {
    assert.ok(alarm.required.includes(field), `Alarm 缺少 ${field}`);
  }
  assert.equal(alarm.additionalProperties, false);
  assert.deepEqual(alarm.properties.severity.enum, ['INFO', 'WARNING', 'MAJOR', 'CRITICAL']);
  assert.deepEqual(alarm.properties.status.enum, ['ACTIVE', 'ACKNOWLEDGED', 'CLEARED']);

  const handle = doc.components.schemas.AlarmHandleResult;
  assert.ok(handle.required.includes('replayed'), '处理结果必须含 replayed');
  assert.equal(handle.additionalProperties, false);

  const reasonBody = doc.components.schemas.AlarmReasonBody;
  assert.deepEqual(reasonBody.required, ['reason'], '确认/清除强制原因');
  assert.equal(reasonBody.additionalProperties, false);
});

test('所有 $ref 可解析（内部引用 + 同目录相对引用 openapi-base.json）', () => {
  const refs = collectRefs(doc);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const hashIdx = ref.indexOf('#');
    const targetFile = hashIdx > 0 ? ref.slice(0, hashIdx) : null;
    const pointer = ref.slice(hashIdx);
    assert.ok(pointer.startsWith('#/'), `仅允许内部/同目录相对引用: ${ref}`);
    const targetDoc = targetFile === null ? doc : targetFile === 'openapi-base.json' ? base : undefined;
    assert.ok(targetDoc, `$ref 目标文件不允许: ${ref}`);
    assert.notEqual(resolvePointer(targetDoc, pointer), undefined, `悬空引用: ${ref}`);
  }
});
