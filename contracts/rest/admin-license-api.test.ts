/**
 * BE-LIC-01 Admin License OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-license-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-license-api.json', import.meta.url), 'utf8'));
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

test('八个端点齐备且 Cognito 认证；operationId 与响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected: [string, string, string[]][] = [
    ['/api/v1/admin/licenses', 'createLicense', ['201', '400', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/licenses/{licenseId}', 'getLicense', ['200', '401', '403', '404', '500']],
    ['/api/v1/admin/licenses/{licenseId}/history', 'listLicenseHistory', ['200', '401', '403', '404', '500']],
    ['/api/v1/admin/licenses/{licenseId}/issue', 'issueLicense', ['200', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/licenses/{licenseId}/activate', 'activateLicense', ['200', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/licenses/{licenseId}/renew', 'renewLicense', ['200', '400', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/licenses/{licenseId}/revoke', 'revokeLicense', ['200', '400', '401', '403', '404', '409', '500']],
    [
      '/api/v1/admin/licenses/{licenseId}/evaluate',
      'evaluateLicense',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
  ];
  for (const [path, operationId, statuses] of expected) {
    const method =
      path.endsWith('licenses') && operationId === 'createLicense'
        ? 'post'
        : path.includes('{licenseId}') && ['getLicense', 'listLicenseHistory'].includes(operationId)
          ? 'get'
          : 'post';
    const op = doc.paths[path]?.[method];
    assert.ok(op, `缺少端点 ${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
    for (const status of statuses) assert.ok(op.responses[status], `${operationId} 缺少 ${status}`);
  }
});

test('Schema 封闭：七态枚举/Entitlement 三码/签名字段/强制原因/幂等与派生字段', () => {
  const license = doc.components.schemas.License;
  assert.equal(license.additionalProperties, false);
  assert.equal(license.properties.status.enum.length, 7, 'DOM-02 七态');
  assert.ok(license.required.includes('signature'), 'License 返回签名字段供 Sync');
  assert.ok(license.required.includes('effective'), '查询时点派生 effective');
  const ent = doc.components.schemas.LicenseEntitlement;
  assert.deepEqual(ent.properties.code.enum, ['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING']);
  const createReq = doc.components.schemas.LicenseCreateRequest;
  assert.deepEqual(createReq.required.sort(), ['deviceId', 'entitlements', 'validFrom', 'validTo'].sort());
  assert.equal(createReq.properties.entitlements.minItems, 1);
  assert.equal(createReq.additionalProperties, false);
  const revokeReq = doc.components.schemas.LicenseRevokeRequest;
  assert.deepEqual(revokeReq.required, ['reason'], '吊销强制原因');
  const renewReq = doc.components.schemas.LicenseRenewRequest;
  assert.deepEqual(renewReq.required, ['newValidTo']);
  // renew/evaluate 响应扩展字段
  const renewData = doc.components.schemas.LicenseRenewSuccess.properties.data;
  assert.ok(JSON.stringify(renewData).includes('"replayed"'), 'renew 响应含幂等回放标记');
  const evalData = doc.components.schemas.LicenseEvaluateSuccess.properties.data;
  assert.ok(JSON.stringify(evalData).includes('"changed"'), 'evaluate 响应含变化标记');
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
