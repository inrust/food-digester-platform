/**
 * BE-DEV-01 Admin Device OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-device-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-device-api.json', import.meta.url), 'utf8'));
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

test('列表/详情端点存在且 Cognito 认证；筛选参数齐备；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const list = doc.paths['/api/v1/admin/devices'].get;
  assert.equal(list.operationId, 'listDevices');
  const detail = doc.paths['/api/v1/admin/devices/{deviceId}'].get;
  assert.equal(detail.operationId, 'getDevice');
  assert.deepEqual(list.security, [{ CognitoJwt: [] }]);
  assert.deepEqual(detail.security, [{ CognitoJwt: [] }]);

  const paramNames = list.parameters.map((p: { name?: string }) => p.name).filter(Boolean);
  for (const name of [
    'customerId',
    'siteId',
    'region',
    'subregion',
    'lifecycleStatus',
    'operationalStatus',
    'connectivity',
    'licenseStatus',
    'model',
    'keyword',
  ]) {
    assert.ok(paramNames.includes(name), `列表缺少筛选参数 ${name}`);
  }
  const byName = Object.fromEntries(
    list.parameters
      .filter((p: { name?: string }) => p.name)
      .map((p: { name: string; schema: { enum?: string[] } }) => [p.name, p]),
  );
  assert.deepEqual(byName.connectivity.schema.enum, ['ONLINE', 'OFFLINE']);
  assert.deepEqual(byName.operationalStatus.schema.enum, ['Active', 'Maintenance', 'Suspended', 'Retired']);
  assert.ok(byName.licenseStatus.schema.enum.includes('None'), '授权轴含 None');
  assert.equal(byName.lifecycleStatus.schema.enum.length, 9, 'DOM-01 九态');

  for (const status of ['200', '400', '401', '403', '500']) {
    assert.ok(list.responses[status], `list 缺少 ${status}`);
  }
  for (const status of ['200', '401', '403', '404', '500']) {
    assert.ok(detail.responses[status], `detail 缺少 ${status}`);
  }
});

test('Device 视图字段封闭（原型设备群表格字段均有来源）；证书仅摘要', () => {
  const device = doc.components.schemas.Device;
  for (const field of [
    'id',
    'serialNumber',
    'model',
    'hardwareVersion',
    'manufacturer',
    'manufactureDate',
    'alias',
    'firmwareVersion',
    'customer',
    'site',
    'lifecycleStatus',
    'operationalStatus',
    'connectivity',
    'lastHeartbeatAt',
    'certificate',
    'license',
    'contract',
    'createdAt',
    'updatedAt',
  ]) {
    assert.ok(device.required.includes(field), `缺少 ${field}`);
  }
  assert.equal(device.additionalProperties, false);
  const cert = doc.components.schemas.DeviceCertificateSummary;
  assert.deepEqual(cert.required.sort(), ['certificateId', 'fingerprint', 'status'].sort(), '证书仅摘要字段');
  const lic = doc.components.schemas.DeviceLicenseSummary;
  assert.ok(lic.required.includes('entitlements'), 'License 摘要含 Entitlement');
  const contract = doc.components.schemas.DeviceContractSummary;
  assert.ok(contract.required.includes('contractNumber'), 'Contract 摘要含合同编号');
  // 敏感材料不得出现在任何 Schema 字段名
  const all = JSON.stringify(doc.components.schemas);
  assert.ok(!/privateKey|certificatePem|packageCiphertext/i.test(all), '不得出现私钥/完整证书字段');
});

test('BE-DEV-06 元数据 PATCH 端点：白名单仅 alias + If-Match 乐观锁 + 409 冲突语义', () => {
  const patch = doc.paths['/api/v1/admin/devices/{deviceId}/metadata']?.patch;
  assert.ok(patch, '缺少 PATCH /api/v1/admin/devices/{deviceId}/metadata');
  assert.equal(patch.operationId, 'updateDeviceMetadata');
  assert.deepEqual(patch.security, [{ CognitoJwt: [] }]);

  // If-Match 头必填
  const ifMatch = patch.parameters.find((p: { name?: string }) => p.name === 'If-Match');
  assert.ok(ifMatch && ifMatch.required === true && ifMatch.in === 'header', 'If-Match 头必填');

  // 请求体白名单：仅 alias，禁止 merge patch（additionalProperties false）
  const update = doc.components.schemas.DeviceMetadataUpdate;
  assert.deepEqual(update.required, ['alias']);
  assert.equal(update.additionalProperties, false);
  assert.deepEqual(Object.keys(update.properties), ['alias'], 'V1 仅 alias 可编辑');

  // 响应码齐备：400（受保护字段/非法值/If-Match 缺失）/403（越权）/404/409（并发与 alias 冲突）
  for (const code of ['200', '400', '401', '403', '404', '409', '500']) {
    assert.ok(patch.responses[code], `metadata PATCH 缺少响应码 ${code}`);
  }
  // 更新视图返回新 updatedAt（下次 If-Match 基准）
  assert.ok(doc.components.schemas.DeviceMetadataView.required.includes('updatedAt'));
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
