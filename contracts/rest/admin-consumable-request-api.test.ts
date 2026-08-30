/**
 * BE-CNS-02 Admin Consumable Request OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-consumable-request-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-consumable-request-api.json', import.meta.url), 'utf8'));
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

test('六个端点齐备且 Cognito 认证；状态迁移强制 If-Match', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected: [string, string, string, string[]][] = [
    [
      '/api/v1/admin/consumable-requests',
      'post',
      'createConsumableRequest',
      ['200', '201', '400', '401', '403', '404', '409', '500'],
    ],
    ['/api/v1/admin/consumable-requests', 'get', 'listConsumableRequests', ['200', '400', '401', '403', '500']],
    [
      '/api/v1/admin/consumable-requests/{requestId}',
      'get',
      'getConsumableRequest',
      ['200', '401', '403', '404', '500'],
    ],
    [
      '/api/v1/admin/consumable-requests/{requestId}/process',
      'post',
      'processConsumableRequest',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/consumable-requests/{requestId}/complete',
      'post',
      'completeConsumableRequest',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/consumable-requests/{requestId}/cancel',
      'post',
      'cancelConsumableRequest',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
  ];
  for (const [path, method, operationId, statuses] of expected) {
    const op = doc.paths[path]?.[method];
    assert.ok(op, `缺少端点 ${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
    for (const status of statuses) assert.ok(op.responses[status], `${operationId} 缺少 ${status}`);
  }
  for (const [, , operationId] of expected.filter(([, , id]) =>
    ['processConsumableRequest', 'completeConsumableRequest', 'cancelConsumableRequest'].includes(id),
  )) {
    const entry = expected.find(([, , id]) => id === operationId);
    const op = doc.paths[entry![0]]?.[entry![1]];
    const ifMatch = (op.parameters ?? []).find((p: { name?: string }) => p.name === 'If-Match');
    assert.ok(ifMatch?.required, `${operationId} 必须强制 If-Match`);
  }
});

test('Schema 封闭：四态枚举/source 固定 ADMIN/幂等 replayed/完整历史字段', () => {
  const request = doc.components.schemas.ConsumableRequest;
  assert.equal(request.additionalProperties, false);
  assert.deepEqual(request.properties.status.enum, ['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED']);
  assert.deepEqual(request.properties.source.enum, ['ADMIN'], '协议冻结前仅管理端创建');
  for (const field of ['requestedAt', 'requestedBy', 'processedBy', 'processNote', 'completedAt', 'version']) {
    assert.ok(request.required.includes(field), `缺历史字段 ${field}`);
  }
  const createReq = doc.components.schemas.ConsumableRequestCreate;
  assert.equal(createReq.additionalProperties, false);
  assert.deepEqual(createReq.properties.consumableType.enum, ['CARBON_FILTER', 'BIO_ADDITIVE']);
  const createSuccess = doc.components.schemas.ConsumableRequestCreateSuccess;
  assert.ok(JSON.stringify(createSuccess).includes('"replayed"'), '幂等回放标记');
  assert.deepEqual(doc.components.schemas.RequestNoteRequiredBody.required, ['note'], '完成/取消强制备注');
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
