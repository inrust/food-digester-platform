/**
 * BE-CERT-01 Certificate Status OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/device-certificate-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./device-certificate-api.json', import.meta.url), 'utf8'));
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

test('端点存在且使用 Device mTLS 认证', () => {
  assert.equal(doc.openapi, '3.1.0');
  const get = doc.paths['/api/v1/device/certificate/status'].get;
  assert.equal(get.operationId, 'getCertificateStatus');
  assert.deepEqual(get.security, [{ DeviceMtls: [] }]);
});

test('状态契约为四态枚举且响应不含 PEM/私钥字段', () => {
  const schema = doc.components.schemas.CertificateStatus;
  assert.deepEqual(schema.properties.status.enum, ['ACTIVE', 'EXPIRING', 'EXPIRED', 'REVOKED']);
  for (const field of ['certificateId', 'status', 'expiryDate', 'daysRemaining']) {
    assert.ok(schema.required.includes(field), `缺少 ${field}`);
  }
  assert.ok(!('certificatePem' in schema.properties) && !('privateKey' in schema.properties));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.expiryDate.pattern, 'expiryDate 必须为 UTC 日期格式');
});

test('跨设备查询语义：deviceId 参数可选且 403 响应存在', () => {
  const get = doc.paths['/api/v1/device/certificate/status'].get;
  const deviceIdParam = get.parameters.find((p: { name?: string }) => p.name === 'deviceId');
  assert.ok(deviceIdParam);
  assert.equal(deviceIdParam.required, false);
  assert.ok(get.responses['403']);
  assert.ok(get.responses['401']);
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
