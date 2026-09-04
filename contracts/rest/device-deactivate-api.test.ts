/**
 * BE-SYNC-02 Device Deactivate OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/device-deactivate-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./device-deactivate-api.json', import.meta.url), 'utf8'));
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

test('deactivate 端点齐备且 DeviceMtls 认证；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const op = doc.paths['/api/v1/device/deactivate'].post;
  assert.equal(op.operationId, 'confirmDeactivation');
  assert.deepEqual(op.security, [{ DeviceMtls: [] }]);
  for (const status of ['200', '401', '404', '409', '500']) {
    assert.ok(op.responses[status], `缺少 ${status}`);
  }
  assert.ok(!op.requestBody, '源稿未定义请求体，deactivate 必须保持无请求体');
  assert.ok(doc.info['x-decision-versions'].includes('DEC-014@1.0.0'));
  assert.ok(!doc.info['x-decision-versions'].some((ref: string) => ref.startsWith('SEC-')));
});

test('响应视图封闭：退役记录 + 证书摘要（无证书材料字段）；幂等字段齐备', () => {
  const result = doc.components.schemas.DeactivationResult;
  for (const field of ['deviceId', 'lifecycleStatus', 'retirement', 'certificates', 'replayed']) {
    assert.ok(result.required.includes(field), `缺少 ${field}`);
  }
  assert.equal(result.additionalProperties, false);
  assert.deepEqual(result.properties.lifecycleStatus.enum, ['Retired']);
  const retirement = doc.components.schemas.RetirementView;
  assert.deepEqual(retirement.properties.status.enum, ['CONFIRMED']);
  assert.deepEqual(retirement.properties.completionMethod.enum, ['DEVICE_CONFIRM', 'FORCE_COMPLETE']);
  const cert = doc.components.schemas.RevokedCertificateSummary;
  assert.deepEqual(cert.required.sort(), ['certificateId', 'fingerprint', 'revokedAt', 'status'].sort());
  // 敏感材料不得出现在任何 Schema 字段名
  const all = JSON.stringify(doc.components.schemas);
  assert.ok(!/privateKey|certificatePem|packageCiphertext/i.test(all), '不得出现私钥/完整证书字段');
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
