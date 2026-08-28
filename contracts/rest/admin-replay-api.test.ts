/**
 * BE-RPL-01 Admin Replay OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-replay-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-replay-api.json', import.meta.url), 'utf8'));
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

test('端点存在且 Cognito 认证；三端点（create/list/detail）响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const collection = doc.paths['/api/v1/admin/replay/jobs'];
  assert.equal(collection.post.operationId, 'createReplayJob');
  assert.equal(collection.get.operationId, 'listReplayJobs');
  assert.deepEqual(collection.post.security, [{ CognitoJwt: [] }]);
  assert.deepEqual(collection.get.security, [{ CognitoJwt: [] }]);
  for (const status of ['201', '400', '401', '403', '404', '500']) {
    assert.ok(collection.post.responses[status], `create 缺少 ${status} 响应`);
  }
  const detail = doc.paths['/api/v1/admin/replay/jobs/{jobId}'].get;
  assert.equal(detail.operationId, 'getReplayJob');
  assert.deepEqual(detail.security, [{ CognitoJwt: [] }]);
  for (const status of ['200', '401', '403', '404', '500']) {
    assert.ok(detail.responses[status], `detail 缺少 ${status} 响应`);
  }
});

test('ReplayJob 视图七字段封闭；状态枚举与统计字段齐备；scope 封闭', () => {
  const job = doc.components.schemas.ReplayJob;
  for (const field of ['jobId', 'scope', 'status', 'resultSummary', 'requestedBy', 'createdAt', 'completedAt']) {
    assert.ok(job.required.includes(field), `缺少 ${field}`);
  }
  assert.equal(job.additionalProperties, false);
  assert.deepEqual(job.properties.status.enum, ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);
  const summary = doc.components.schemas.ReplayResultSummary;
  for (const field of ['scannedObjects', 'scannedLines', 'sent', 'skipped', 'failed']) {
    assert.ok(summary.required.includes(field), `统计缺少 ${field}`);
  }
  const scope = doc.components.schemas.ReplayScope;
  assert.equal(scope.additionalProperties, false);
  assert.deepEqual(scope.properties.topicType.enum, ['telemetry', 'report', 'alarm', 'event', 'tamper', 'ack']);
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
