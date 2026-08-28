/**
 * BE-DEV-02 Admin Device Assignment OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-device-assignment-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-device-assignment-api.json', import.meta.url), 'utf8'));
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

test('分配/历史端点齐备且 Cognito 认证；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const assign = doc.paths['/api/v1/admin/devices/{deviceId}/assignment'].post;
  assert.equal(assign.operationId, 'assignDevice');
  assert.deepEqual(assign.security, [{ CognitoJwt: [] }]);
  for (const status of ['200', '400', '401', '403', '404', '409', '500']) {
    assert.ok(assign.responses[status], `assign 缺少 ${status}`);
  }
  const history = doc.paths['/api/v1/admin/devices/{deviceId}/assignments'].get;
  assert.equal(history.operationId, 'listDeviceAssignments');
  assert.deepEqual(history.security, [{ CognitoJwt: [] }]);
  for (const status of ['200', '401', '403', '404', '500']) {
    assert.ok(history.responses[status], `history 缺少 ${status}`);
  }
});

test('DeviceAssignment 视图封闭：授权窗口（assignedAt/endedAt）+ 幂等/通知字段齐备', () => {
  const a = doc.components.schemas.DeviceAssignment;
  for (const field of [
    'assignmentId',
    'deviceId',
    'customerId',
    'siteId',
    'status',
    'assignedBy',
    'reason',
    'assignedAt',
    'endedAt',
    'lifecycleStatus',
    'notification',
    'replayed',
  ]) {
    assert.ok(a.required.includes(field), `缺少 ${field}`);
  }
  assert.equal(a.additionalProperties, false);
  assert.deepEqual(a.properties.status.enum, ['ACTIVE', 'ENDED']);
  assert.deepEqual(a.properties.notification.enum, ['ASSIGNMENT_CHANGED', null]);
  const req = doc.components.schemas.AssignmentRequest;
  assert.deepEqual(req.required.sort(), ['customerId', 'siteId']);
  assert.equal(req.additionalProperties, false);
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
