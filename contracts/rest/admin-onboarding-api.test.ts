/**
 * BE-ONB-02 管理端 Onboarding 审批 OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-onboarding-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-onboarding-api.json', import.meta.url), 'utf8'));
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
  if (Array.isArray(node)) {
    node.forEach((item) => collectRefs(item, out));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

test('四个审批端点存在且使用 Cognito JWT 认证', () => {
  assert.equal(doc.openapi, '3.1.0');
  const list = doc.paths['/api/v1/admin/onboarding/requests'].get;
  const detail = doc.paths['/api/v1/admin/onboarding/requests/{requestId}'].get;
  const approve = doc.paths['/api/v1/admin/onboarding/requests/{requestId}/approve'].post;
  const reject = doc.paths['/api/v1/admin/onboarding/requests/{requestId}/reject'].post;
  for (const op of [list, detail, approve, reject]) {
    assert.deepEqual(op.security, [{ CognitoJwt: [] }], op.operationId);
  }
});

test('approve/reject 强制 If-Match；reject 强制 reason', () => {
  const approve = doc.paths['/api/v1/admin/onboarding/requests/{requestId}/approve'].post;
  const reject = doc.paths['/api/v1/admin/onboarding/requests/{requestId}/reject'].post;
  const ifMatch = base.components.parameters.IfMatch;
  for (const op of [approve, reject]) {
    const ref = op.parameters.find((p: { $ref?: string }) => p.$ref?.endsWith('/IfMatch'));
    assert.ok(ref, `${op.operationId} 缺少 If-Match 参数`);
    assert.equal(ifMatch.required, true);
    assert.ok(op.responses['409'], `${op.operationId} 缺少 409 响应`);
  }
  const rejectBody = doc.components.schemas.RejectOnboardingRequestInput;
  assert.deepEqual(rejectBody.required, ['reason']);
});

test('申请 DTO 不含 tokenId（Token 关联不暴露）', () => {
  const schema = doc.components.schemas.OnboardingRequest;
  assert.ok(!('tokenId' in schema.properties));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('rejectReason'), 'Rejected 原因必须可查询');
  assert.ok(schema.required.includes('version'), '详情必须携带 version 供 If-Match');
});

test('管理端明确暴露内部 TIMED_OUT，列表状态过滤为封闭枚举', () => {
  const status = doc.components.schemas.OnboardingRequest.properties.status;
  assert.deepEqual(status.enum, ['PENDING', 'APPROVED', 'REJECTED', 'TIMED_OUT']);
  const parameter = doc.paths['/api/v1/admin/onboarding/requests'].get.parameters.find(
    (item: { name?: string }) => item.name === 'status',
  );
  assert.deepEqual(parameter.schema.enum, status.enum);
  assert.ok(doc.info['x-decision-versions'].includes('DEC-017@1.0.0'));
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
