/**
 * BE-DEV-04 Admin Device Retirement OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-device-retirement-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-device-retirement-api.json', import.meta.url), 'utf8'));
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

test('retire/force-complete 端点齐备且 Cognito 认证；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const retire = doc.paths['/api/v1/admin/devices/{deviceId}/retire'].post;
  assert.equal(retire.operationId, 'retireDevice');
  const complete = doc.paths['/api/v1/admin/devices/{deviceId}/retire/complete'].post;
  assert.equal(complete.operationId, 'forceCompleteRetirement');
  for (const op of [retire, complete]) {
    assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
    for (const status of ['200', '400', '401', '403', '404', '409', '500']) {
      assert.ok(op.responses[status], `${op.operationId} 缺少 ${status}`);
    }
  }
});

test('请求体封闭：retire 强制原因 + confirm 恒 true；视图封闭且通知枚举正确', () => {
  const retireReq = doc.components.schemas.RetireRequest;
  assert.deepEqual(retireReq.required.sort(), ['confirm', 'reason']);
  assert.deepEqual(retireReq.properties.confirm.enum, [true]);
  assert.equal(retireReq.additionalProperties, false);
  const fcReq = doc.components.schemas.ForceCompleteRequest;
  assert.deepEqual(fcReq.required, ['reason']);
  assert.equal(fcReq.additionalProperties, false);
  const result = doc.components.schemas.RetirementResult;
  assert.equal(result.additionalProperties, false);
  assert.deepEqual(result.properties.lifecycleStatus.enum, ['Retired']);
  assert.deepEqual(result.properties.notification.enum, ['DEVICE_RETIRED', null]);
  const record = doc.components.schemas.RetirementRecord;
  assert.deepEqual(record.properties.status.enum, ['PENDING_CONFIRMATION', 'CONFIRMED']);
  assert.deepEqual(record.properties.completionMethod.enum, [
    'DEVICE_CONFIRM',
    'FORCE_COMPLETE',
    'UNCONFIRMED_TIMEOUT',
    null,
  ]);
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
