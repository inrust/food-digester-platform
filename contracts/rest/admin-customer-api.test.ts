/**
 * BE-CUS-01 Admin Customer OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-customer-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-customer-api.json', import.meta.url), 'utf8'));
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

test('六端点齐备且 Cognito 认证；写操作声明 If-Match；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const collection = doc.paths['/api/v1/admin/customers'];
  assert.equal(collection.get.operationId, 'listCustomers');
  assert.equal(collection.post.operationId, 'createCustomer');
  const item = doc.paths['/api/v1/admin/customers/{customerId}'];
  assert.equal(item.get.operationId, 'getCustomer');
  assert.equal(item.patch.operationId, 'updateCustomer');
  assert.equal(item.delete.operationId, 'deleteCustomer');
  const deactivate = doc.paths['/api/v1/admin/customers/{customerId}/deactivate'].post;
  assert.equal(deactivate.operationId, 'deactivateCustomer');

  const ops = [collection.get, collection.post, item.get, item.patch, item.delete, deactivate];
  for (const op of ops) {
    assert.deepEqual(op.security, [{ CognitoJwt: [] }], `${op.operationId} 必须 Cognito 认证`);
  }
  // 列表/详情
  for (const status of ['401', '403', '500']) {
    assert.ok(collection.get.responses[status], `list 缺少 ${status}`);
    assert.ok(item.get.responses[status], `detail 缺少 ${status}`);
  }
  assert.ok(collection.get.responses['200']);
  assert.ok(item.get.responses['200'] && item.get.responses['404']);
  // 创建
  for (const status of ['201', '400', '401', '403', '500']) {
    assert.ok(collection.post.responses[status], `create 缺少 ${status}`);
  }
  // 写操作（update/deactivate/delete）：If-Match 必填 + 409
  for (const op of [item.patch, item.delete, deactivate]) {
    const hasIfMatch = op.parameters.some(
      (p: { $ref?: string }) => p.$ref === 'openapi-base.json#/components/parameters/IfMatch',
    );
    assert.ok(hasIfMatch, `${op.operationId} 缺少 If-Match 参数`);
    for (const status of ['200', '400', '401', '403', '404', '409', '500']) {
      assert.ok(op.responses[status], `${op.operationId} 缺少 ${status}`);
    }
  }
});

test('Customer 视图六字段封闭；status 枚举 ACTIVE|SUSPENDED；请求体封闭', () => {
  const customer = doc.components.schemas.Customer;
  for (const field of ['id', 'name', 'status', 'version', 'createdAt', 'updatedAt']) {
    assert.ok(customer.required.includes(field), `缺少 ${field}`);
  }
  assert.equal(customer.additionalProperties, false);
  assert.deepEqual(customer.properties.status.enum, ['ACTIVE', 'SUSPENDED']);
  assert.equal(customer.properties.version.minimum, 1);
  for (const name of ['CustomerCreateRequest', 'CustomerUpdateRequest', 'CustomerDeactivateRequest']) {
    assert.equal(doc.components.schemas[name].additionalProperties, false, `${name} 必须封闭`);
  }
  assert.deepEqual(doc.components.schemas.CustomerDeactivateRequest.required, ['reason'], '停用强制原因');
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
