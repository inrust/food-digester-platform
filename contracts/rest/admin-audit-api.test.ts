/**
 * BE-AUD-01 Admin Audit OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-audit-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-audit-api.json', import.meta.url), 'utf8'));
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

test('端点齐备且 CognitoJwt 认证：列表 + 详情', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expectations: Array<[string, string, string, string[]]> = [
    ['/api/v1/admin/audit-logs', 'get', 'listAuditLogs', ['200', '400', '401', '403']],
    ['/api/v1/admin/audit-logs/{auditId}', 'get', 'getAuditLogDetail', ['200', '401', '403', '404']],
  ];
  for (const [path, method, operationId, codes] of expectations) {
    const op = doc.paths[path]?.[method];
    assert.ok(op, `缺少端点 ${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }], `${operationId} 必须 CognitoJwt`);
    for (const code of codes) {
      assert.ok(op.responses[code], `${operationId} 缺少响应码 ${code}`);
    }
  }
});

test('只读 API：不存在任何写路由（post/put/patch/delete）', () => {
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      assert.ok(!['post', 'put', 'patch', 'delete'].includes(method), `${path} 不允许写方法 ${method}`);
    }
  }
});

test('筛选参数齐备（actor/Customer/对象/动作/结果/时间 + 游标分页）；响应不暴露敏感字段', () => {
  const list = doc.paths['/api/v1/admin/audit-logs'].get;
  const names = list.parameters.map((p: Record<string, unknown>) => p.name ?? p.$ref);
  for (const required of ['actorId', 'customerId', 'objectType', 'objectId', 'action', 'result', 'from', 'to']) {
    assert.ok(names.includes(required), `列表缺少筛选参数 ${required}`);
  }
  assert.deepEqual(list.parameters.find((p: Record<string, unknown>) => p.name === 'result').schema.enum, [
    'SUCCESS',
    'FAILURE',
  ]);

  // 视图禁止暴露敏感字段名（password/secret/token/privateKey/hash/credential）
  for (const schemaName of ['AuditLogView', 'AuditLogDetailView']) {
    const schema = doc.components.schemas[schemaName];
    assert.equal(schema.additionalProperties, false);
    const json = JSON.stringify(schema.properties).toLowerCase();
    for (const forbidden of ['password', 'secret', 'token', 'privatekey', 'hash', 'credential']) {
      assert.ok(!json.includes(forbidden), `${schemaName} 不得暴露 ${forbidden}`);
    }
  }
  // 列表视图不含前后值；详情视图包含（脱敏语义在描述中声明）
  assert.ok(!('beforeValue' in doc.components.schemas.AuditLogView.properties));
  assert.ok(!('afterValue' in doc.components.schemas.AuditLogView.properties));
  assert.ok('beforeValue' in doc.components.schemas.AuditLogDetailView.properties);
  assert.ok('afterValue' in doc.components.schemas.AuditLogDetailView.properties);
});

test('所有 $ref 可解析（内部引用 + openapi-base.json）', () => {
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
