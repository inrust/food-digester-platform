/**
 * BE-OTA-01 Admin Firmware Package OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-ota-package-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-ota-package-api.json', import.meta.url), 'utf8'));
const base = JSON.parse(readFileSync(new URL('./openapi-base.json', import.meta.url), 'utf8'));
const otaMqtt = JSON.parse(readFileSync(new URL('../mqtt/schemas/ota.schema.json', import.meta.url), 'utf8'));

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

test('端点齐备且 CognitoJwt 认证：上传会话/complete/列表/详情', () => {
  assert.equal(doc.openapi, '3.1.0');
  const create = doc.paths['/api/v1/admin/ota/packages/upload-sessions'].post;
  assert.ok(create, '缺少上传会话端点');
  assert.equal(create.operationId, 'createFirmwareUpload');
  assert.deepEqual(create.security, [{ CognitoJwt: [] }]);
  for (const code of ['201', '400', '401', '403', '409']) {
    assert.ok(create.responses[code], `上传会话缺少响应码 ${code}`);
  }

  const complete = doc.paths['/api/v1/admin/ota/packages/{packageId}/complete'].post;
  assert.ok(complete, '缺少 complete 端点');
  assert.equal(complete.operationId, 'completeFirmwareUpload');
  assert.deepEqual(complete.security, [{ CognitoJwt: [] }]);
  for (const code of ['200', '400', '401', '403', '404', '409']) {
    assert.ok(complete.responses[code], `complete 缺少响应码 ${code}`);
  }

  const list = doc.paths['/api/v1/admin/ota/packages'].get;
  assert.ok(list, '缺少列表端点');
  assert.equal(list.operationId, 'listFirmwarePackages');
  const detail = doc.paths['/api/v1/admin/ota/packages/{packageId}'].get;
  assert.ok(detail, '缺少详情端点');
  assert.equal(detail.operationId, 'getFirmwarePackage');
  assert.ok(detail.responses['404'], '详情缺少 404');
});

test('packageType/sha256 与 CT-03 OTA Schema 一致；创建字段封闭且签名必填', () => {
  // packageType 枚举与 MQTT OTA Schema 完全一致
  const mqttPackageType = otaMqtt.properties.data.properties.packageType.enum;
  assert.deepEqual(doc.components.schemas.FirmwarePackageType.enum, mqttPackageType);
  // sha256 模式与 MQTT OTA Schema 一致
  assert.equal(
    doc.components.schemas.FirmwareUploadSessionCreate.properties.sha256.pattern,
    otaMqtt.properties.data.properties.sha256.pattern,
  );

  const create = doc.components.schemas.FirmwareUploadSessionCreate;
  assert.equal(create.additionalProperties, false);
  assert.deepEqual(create.required, ['model', 'version', 'packageType', 'sizeBytes', 'sha256', 'signature']);
  assert.equal(create.properties.sizeBytes.minimum, 1);
  // model/version 禁止路径字符（objectKey 服务端生成，防路径穿越）
  assert.ok(create.properties.model.pattern.includes('[A-Za-z0-9._-]'));
  assert.ok(create.properties.version.pattern.includes('[A-Za-z0-9._-]'));
});

test('状态机封闭：UPLOADED/VERIFIED/RETIRED；可发布=VERIFIED；视图不泄露信任根', () => {
  assert.deepEqual(doc.components.schemas.FirmwarePackageStatus.enum, ['UPLOADED', 'VERIFIED', 'RETIRED']);

  const session = doc.components.schemas.FirmwareUploadSessionView;
  assert.equal(session.additionalProperties, false);
  assert.deepEqual(session.properties.status.enum, ['UPLOADED'], '会话创建后固定 UPLOADED');
  assert.equal(session.properties.uploadUrl.pattern, '^https://', '预签名 URL 必须 https');
  for (const field of ['objectKey', 'uploadUrl', 'uploadUrlExpiresAt']) {
    assert.ok(session.required.includes(field), `会话视图缺少 ${field}`);
  }

  const view = doc.components.schemas.FirmwarePackageView;
  assert.equal(view.additionalProperties, false);
  for (const field of ['packageId', 'model', 'version', 'packageType', 'sizeBytes', 'sha256', 'status', 'uploadedBy']) {
    assert.ok(view.required.includes(field), `FirmwarePackageView 缺少 ${field}`);
  }
  // 不信任根/签名材料/内部 Bucket 信息外泄
  const leaked = JSON.stringify(view.properties);
  for (const forbidden of ['trustRoot', 'signature', 'bucket']) {
    assert.ok(!leaked.includes(forbidden), `视图不得暴露 ${forbidden}`);
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
