/**
 * BE-DEV-03 Admin Device Status OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-device-status-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-device-status-api.json', import.meta.url), 'utf8'));
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

test('suspend/reactivate 端点齐备且 Cognito 认证；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const suspend = doc.paths['/api/v1/admin/devices/{deviceId}/suspend'].post;
  assert.equal(suspend.operationId, 'suspendDevice');
  const reactivate = doc.paths['/api/v1/admin/devices/{deviceId}/reactivate'].post;
  assert.equal(reactivate.operationId, 'reactivateDevice');
  for (const op of [suspend, reactivate]) {
    assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
    for (const status of ['200', '400', '401', '403', '404', '409', '500']) {
      assert.ok(op.responses[status], `${op.operationId} 缺少 ${status}`);
    }
  }
});

test('请求体封闭：挂起强制原因；恢复强制原因 + issueResolved 恒 true；通知枚举正确', () => {
  const suspendReq = doc.components.schemas.SuspendRequest;
  assert.deepEqual(suspendReq.required, ['reason']);
  assert.equal(suspendReq.additionalProperties, false);
  const reactivateReq = doc.components.schemas.ReactivateRequest;
  assert.deepEqual(reactivateReq.required.sort(), ['issueResolved', 'reason']);
  assert.deepEqual(reactivateReq.properties.issueResolved.enum, [true], '恢复强制问题已解决标志');
  assert.equal(reactivateReq.additionalProperties, false);
  const view = doc.components.schemas.DeviceStatus;
  assert.equal(view.additionalProperties, false);
  assert.deepEqual(view.properties.notification.enum, ['DEVICE_SUSPENDED', 'STATUS_CHANGED', null]);
  assert.deepEqual(view.properties.lifecycleStatus.enum, ['Active', 'Suspended']);
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
