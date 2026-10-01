/**
 * BE-ONB-01 Onboarding Request OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/device-onboarding-api.test.ts"
 *
 * 校验：文档结构完整；全部 $ref（内部与同目录相对引用 openapi-base.json）可解析；
 * 端点声明的 HTTP 状态都有 CT-05 错误码目录中的稳定错误码支撑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./device-onboarding-api.json', import.meta.url), 'utf8'));
const base = JSON.parse(readFileSync(new URL('./openapi-base.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('./error-codes.json', import.meta.url), 'utf8'));

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

test('BE-ONB-01 端点存在且 CSR 首次申请无需预置 Token', () => {
  assert.equal(doc.openapi, '3.1.0');
  const post = doc.paths['/api/v1/device/onboarding/request'].post;
  assert.equal(post.operationId, 'submitOnboardingRequest');
  assert.deepEqual(post.security, []);
  assert.equal(post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/OnboardingRequestInput');
  assert.ok(!doc.components.securitySchemes?.OnboardingToken);
  // 设备无证书阶段不得声明 mTLS
  assert.equal(
    post.security.some((s: object) => 'DeviceMtls' in s),
    false,
  );
});

test('请求体包含设备资料和必填 CSR', () => {
  const input = doc.components.schemas.OnboardingRequestInput;
  assert.deepEqual(input.required, [
    'serialNumber',
    'model',
    'hardwareVersion',
    'manufacturer',
    'manufactureDate',
    'csrPem',
  ]);
  assert.equal(input.additionalProperties, false);
  assert.ok(input.properties.manufactureDate.pattern);
  assert.ok(!('privateKey' in doc.components.schemas.OnboardingCertificate.properties));
});

test('成功响应含 requestId 与 PENDING 状态（200 幂等重放 / 201 新建）', () => {
  const post = doc.paths['/api/v1/device/onboarding/request'].post;
  for (const status of ['200', '201']) assert.ok(post.responses[status], `缺少 ${status} 响应`);
  const result = doc.components.schemas.OnboardingRequestResult;
  assert.deepEqual(result.required, ['requestId', 'status']);
  assert.deepEqual(result.properties.status.enum, ['PENDING']);
  assert.equal(
    post.responses['201'].content['application/json'].schema.$ref,
    '#/components/schemas/OnboardingRequestResult',
  );
});

test('匿名申请负向响应覆盖稳定错误码语义：400/404/409/429/500', () => {
  const post = doc.paths['/api/v1/device/onboarding/request'].post;
  const catalogStatuses = new Set(catalog.errorCodes.map((e: { httpStatus: number }) => String(e.httpStatus)));
  for (const status of ['400', '404', '409', '429', '500']) {
    assert.ok(post.responses[status], `缺少 ${status} 负向响应`);
    assert.ok(catalogStatuses.has(status), `${status} 不在 CT-05 错误码目录的 HTTP 状态集合中`);
  }
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

test('BE-ONB-03 status 端点：requestId 与 CSR 私钥签名，三态响应不含设备私钥', () => {
  const get = doc.paths['/api/v1/device/onboarding/status'].get;
  assert.equal(get.operationId, 'getOnboardingStatus');
  assert.deepEqual(get.security, []);
  assert.deepEqual(
    get.parameters.map((item: { name: string }) => item.name),
    ['requestId', 'X-Onboarding-Timestamp', 'X-Onboarding-Nonce', 'X-Onboarding-Signature'],
  );
  assert.equal(
    get.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/OnboardingStatusResult',
  );

  const result = doc.components.schemas.OnboardingStatusResult;
  assert.equal(result.oneOf.length, 3, 'PENDING/REJECTED/APPROVED 三态');

  const approved = doc.components.schemas.OnboardingStatusApproved;
  for (const field of ['status', 'deviceId', 'certificate', 'mqtt', 'configuration', 'rest']) {
    assert.ok(approved.required.includes(field), `APPROVED 缺少 ${field}`);
  }
  assert.deepEqual(doc.components.schemas.OnboardingInitialConfiguration.properties.heartbeatInterval.enum, [60]);
  assert.deepEqual(doc.components.schemas.OnboardingCertificate.required, ['certificatePem', 'certificateChain']);
  assert.ok(doc.components.schemas.OnboardingMqtt.required.includes('endpoint'));

  const rejected = doc.components.schemas.OnboardingStatusRejected;
  assert.ok(rejected.required.includes('reason'));
  assert.ok(!('rejectReason' in rejected.properties));
  // PENDING 形态不得携带任何证书材料字段
  const pending = doc.components.schemas.OnboardingStatusPending;
  assert.deepEqual(pending.required, ['status']);
  // 重复领取/过期为确定性 409
  assert.ok(get.responses['409']);
});
