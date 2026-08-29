/**
 * BE-CON-02 Admin Contract-Device OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-contract-device-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-contract-device-api.json', import.meta.url), 'utf8'));
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

test('五个端点齐备且 Cognito 认证；operationId 与响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected: [string, string, string, string[]][] = [
    ['/api/v1/admin/contracts/{contractId}/devices', 'get', 'listContractDevices', ['200', '401', '403', '404', '500']],
    [
      '/api/v1/admin/contracts/{contractId}/available-devices',
      'get',
      'listAvailableDevices',
      ['200', '401', '403', '404', '500'],
    ],
    [
      '/api/v1/admin/contracts/{contractId}/associations',
      'get',
      'listContractAssociations',
      ['200', '401', '403', '404', '500'],
    ],
    [
      '/api/v1/admin/contracts/{contractId}/devices/bind',
      'post',
      'bindContractDevices',
      ['201', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/contracts/{contractId}/devices/unbind',
      'post',
      'unbindContractDevices',
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
});

test('Schema 封闭：设备视图字段齐备/关联窗口/强制原因/批量语义', () => {
  const snapshot = doc.components.schemas.ContractDeviceSnapshot;
  assert.equal(snapshot.additionalProperties, false);
  for (const field of [
    'deviceId',
    'alias',
    'site',
    'lifecycleStatus',
    'operationalStatus',
    'connectivity',
    'licenseStatus',
    'firmwareVersion',
  ]) {
    assert.ok(snapshot.required.includes(field), `设备视图缺 ${field}`);
  }
  assert.deepEqual(snapshot.properties.connectivity.enum, ['ONLINE', 'OFFLINE']);
  const association = doc.components.schemas.ContractDeviceAssociation;
  assert.equal(association.additionalProperties, false);
  assert.deepEqual(association.properties.status.enum, ['ACTIVE', 'ENDED']);
  assert.ok(association.required.includes('validFrom') && association.required.includes('validTo'), '租期展示值');
  const bindReq = doc.components.schemas.BindDevicesRequest;
  assert.equal(bindReq.additionalProperties, false);
  assert.deepEqual(bindReq.required.sort(), ['deviceIds', 'reason'].sort(), '批量关联强制原因');
  assert.equal(bindReq.properties.deviceIds.minItems, 1, '批量全成或全败语义入口');
  const unbindReq = doc.components.schemas.UnbindDevicesRequest;
  assert.deepEqual(unbindReq.required.sort(), ['deviceIds', 'reason'].sort());
  const detail = doc.components.schemas.ContractDeviceDetail;
  assert.deepEqual(detail.required.sort(), ['association', 'device'].sort());
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
