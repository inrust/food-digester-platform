/**
 * BE-CNS-01 Admin Consumable OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-consumable-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-consumable-api.json', import.meta.url), 'utf8'));
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

test('列表与按需联系人端点齐备且 Cognito 认证；筛选参数齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const op = doc.paths['/api/v1/admin/consumables']?.get;
  assert.ok(op, '缺少 GET /api/v1/admin/consumables');
  assert.equal(op.operationId, 'listConsumableStatus');
  assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
  for (const status of ['200', '400', '401', '403', '500']) assert.ok(op.responses[status], `缺少 ${status}`);
  const params = new Set((op.parameters ?? []).map((p: { name: string }) => p.name));
  const parameterRefs = new Set((op.parameters ?? []).map((p: { $ref?: string }) => p.$ref));
  assert.ok(parameterRefs.has('openapi-base.json#/components/parameters/Limit'), '缺少 limit 游标分页参数');
  assert.ok(parameterRefs.has('openapi-base.json#/components/parameters/Cursor'), '缺少 cursor 游标分页参数');
  for (const name of [
    'region',
    'subregion',
    'siteId',
    'connectivity',
    'keyword',
    'maxRemainingPercent',
    'consumableType',
    'customerId',
  ]) {
    assert.ok(params.has(name), `缺少筛选参数 ${name}`);
  }
  assert.equal(
    doc.components.schemas.ConsumableListSuccess.properties.meta.$ref,
    'openapi-base.json#/components/schemas/PageMeta',
  );
  const threshold = op.parameters.find((p: { name: string }) => p.name === 'maxRemainingPercent');
  assert.equal(threshold.schema.minimum, 0);
  assert.equal(threshold.schema.maximum, 100);
  const contact = doc.paths['/api/v1/admin/consumables/{deviceId}/contact']?.get;
  assert.ok(contact, '缺少 GET /api/v1/admin/consumables/{deviceId}/contact');
  assert.equal(contact.operationId, 'getConsumableContact');
  assert.deepEqual(contact.security, [{ CognitoJwt: [] }]);
  for (const status of ['200', '401', '403', '404', '500']) assert.ok(contact.responses[status], `缺少 ${status}`);
});

test('Schema 封闭：两种耗材列恒在；列表零联系人 PII；按需联系人独立；百分比 0~100', () => {
  const status = doc.components.schemas.ConsumableStatus;
  assert.equal(status.additionalProperties, false);
  assert.ok(status.required.includes('consumables'));
  assert.equal(status.required.includes('contact'), false);
  assert.equal(Object.hasOwn(status.properties, 'contact'), false, '列表 Schema 不得携联系人');
  const consumables = status.properties.consumables;
  assert.deepEqual(consumables.required.sort(), ['BIO_ADDITIVE', 'CARBON_FILTER'].sort(), '两种耗材列恒在');
  assert.equal(consumables.additionalProperties, false, '封闭集合，不允许第三种耗材');
  const value = doc.components.schemas.ConsumableValue;
  assert.equal(value.additionalProperties, false);
  assert.deepEqual(value.properties.remainingPercent.type.sort(), ['integer', 'null']);
  assert.equal(value.properties.remainingPercent.maximum, 100);
  assert.ok(value.properties.remainingDisplay.description.includes('unknown'), '未知值显示 unknown');
  const contact = doc.components.schemas.ConsumableContact;
  assert.deepEqual(contact.required.sort(), ['email', 'name', 'phone'].sort());
  assert.equal(contact.additionalProperties, false);
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
