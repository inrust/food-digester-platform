/**
 * BE-MED-01 Media REST 契约校验（设备上传会话 + 管理端查询/下载）。
 * 运行：node --import tsx --test contracts/rest/media-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const device = JSON.parse(readFileSync(new URL('./device-media-api.json', import.meta.url), 'utf8'));
const admin = JSON.parse(readFileSync(new URL('./admin-media-api.json', import.meta.url), 'utf8'));
const base = JSON.parse(readFileSync(new URL('./openapi-base.json', import.meta.url), 'utf8'));
const mediaMqtt = JSON.parse(readFileSync(new URL('../mqtt/schemas/media.schema.json', import.meta.url), 'utf8'));
const uploadPolicy = JSON.parse(readFileSync(new URL('../media/media-upload-policy.json', import.meta.url), 'utf8'));

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

test('设备端：上传会话端点齐备且 DeviceMtls 认证；输入封闭；objectPath 由服务端签发', () => {
  const create = device.paths['/api/v1/device/media/upload-sessions'].post;
  assert.ok(create, '缺少上传会话端点');
  assert.equal(create.operationId, 'createMediaUploadSession');
  assert.deepEqual(create.security, [{ DeviceMtls: [] }]);
  for (const code of ['201', '400', '401', '403', '409']) {
    assert.ok(create.responses[code], `缺少响应码 ${code}`);
  }

  const input = device.components.schemas.MediaUploadSessionCreate;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, ['mediaType', 'fileName', 'sizeKb', 'sizeBytes', 'sha256']);
  // mediaType 与 CT-03 media.schema.json 枚举一致
  assert.deepEqual(input.properties.mediaType.enum, mediaMqtt.properties.data.properties.mediaType.enum);
  // 输入不得包含 objectPath/bucket（objectPath 服务端签发）
  assert.ok(!('objectPath' in input.properties), '客户端不得指定 objectPath');
  assert.ok(!('bucket' in input.properties), '客户端不得指定 Bucket');
  // fileName 禁止路径字符（objectPath 组成部分）
  assert.equal(input.properties.fileName.pattern, '^[A-Za-z0-9._-]+$');

  const view = device.components.schemas.MediaUploadSessionView;
  assert.equal(view.additionalProperties, false);
  assert.equal(view.properties.uploadUrl.pattern, '^https://');
  for (const field of ['sessionId', 'objectPath', 'uploadUrl', 'uploadUrlExpiresAt']) {
    assert.ok(view.required.includes(field), `会话视图缺少 ${field}`);
  }
});

test('管理端：列表/下载端点齐备且 CognitoJwt 认证；视图不泄露内部存储信息', () => {
  const list = admin.paths['/api/v1/admin/media'].get;
  assert.equal(list.operationId, 'listMedia');
  assert.deepEqual(list.security, [{ CognitoJwt: [] }]);
  const download = admin.paths['/api/v1/admin/media/{mediaId}/download-url'].get;
  assert.equal(download.operationId, 'createMediaDownloadUrl');
  assert.deepEqual(download.security, [{ CognitoJwt: [] }]);
  assert.ok(download.responses['404'], '下载须含 404（跨 Customer/已删除）');

  const view = admin.components.schemas.MediaView;
  assert.equal(view.additionalProperties, false);
  const leaked = JSON.stringify(view.properties);
  for (const forbidden of ['objectPath', 'bucket', 'uploadSessionId', 'sourceMessageId']) {
    assert.ok(!leaked.includes(forbidden), `视图不得暴露 ${forbidden}`);
  }
  // DEC-009：无实时流媒体字段（不含 RTSP/WebRTC/HLS 会话）
  for (const streaming of ['rtsp', 'webrtc', 'hls', 'streamUrl']) {
    assert.ok(!JSON.stringify(admin.components.schemas).toLowerCase().includes(streaming), `不得包含 ${streaming}`);
  }
  assert.equal(admin.components.schemas.MediaDownloadUrlView.properties.downloadUrl.pattern, '^https://');
});

test('Media 状态枚举封闭（AVAILABLE/DELETED）；配额/大小引用策略暂定值', () => {
  assert.deepEqual(admin.components.schemas.MediaView.properties.status.enum, ['AVAILABLE', 'DELETED']);
  assert.deepEqual(
    admin.paths['/api/v1/admin/media'].get.parameters.find((p: { name?: string }) => p.name === 'status').schema.enum,
    ['AVAILABLE', 'DELETED'],
  );
  // 契约描述与策略暂定值一致（TTL 900s、IMAGE/VIDEO 上限）
  const desc = device.info.description + JSON.stringify(device.components.schemas);
  assert.ok(desc.includes('900'), '上传 TTL 应与策略一致（900s）');
  assert.ok(desc.includes(String(uploadPolicy.limits.maxSizeKb.IMAGE)));
  assert.ok(desc.includes(String(uploadPolicy.limits.maxSizeKb.VIDEO)));
});

test('所有 $ref 可解析（内部引用 + openapi-base.json）', () => {
  for (const doc of [device, admin]) {
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
  }
});
