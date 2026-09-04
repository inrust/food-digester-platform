/**
 * BE-SYNC-01 Unified Device Sync OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/device-sync-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./device-sync-api.json', import.meta.url), 'utf8'));
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

test('sync 端点齐备且 DeviceMtls 认证；响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const op = doc.paths['/api/v1/device/sync'].post;
  assert.equal(op.operationId, 'syncDevice');
  assert.deepEqual(op.security, [{ DeviceMtls: [] }]);
  for (const status of ['200', '400', '401', '403', '500']) {
    assert.ok(op.responses[status], `缺少 ${status}`);
  }
});

test('请求体封闭：仅 lastSyncTime（UTC 时间戳或 null）', () => {
  const req = doc.components.schemas.SyncRequest;
  assert.equal(req.additionalProperties, false);
  assert.deepEqual(Object.keys(req.properties), ['lastSyncTime']);
  assert.ok(!req.required?.includes('lastSyncTime'), '首次同步可省略');
});

test('快照顶层与源稿六域同形，兼容元数据不成为必填线协议', () => {
  const snapshot = doc.components.schemas.DeviceSyncSnapshot;
  const required = ['assignment', 'device', 'license', 'deviceUsers', 'configuration', 'operationalStatus'];
  assert.deepEqual([...snapshot.required].sort(), required.sort());
  assert.equal(snapshot.additionalProperties, false);
  assert.equal(
    doc.paths['/api/v1/device/sync'].post.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/DeviceSyncSnapshot',
  );

  const license = doc.components.schemas.SyncLicense;
  for (const field of ['status', 'validFrom', 'validTo', 'entitlements', 'signature']) {
    assert.ok(license.required.includes(field), `License 缺少 ${field}`);
  }
  assert.ok(license.properties.status.enum.includes('ACTIVE'));
  assert.ok(!license.properties.status.enum.includes('Active'));
  assert.deepEqual(license.properties.entitlements.items.enum, ['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING']);
  assert.equal(license.properties.validFrom.format, 'date');

  const user = doc.components.schemas.SyncDeviceUser;
  assert.deepEqual(user.required, ['userId', 'username', 'displayName', 'passwordHash', 'status']);
  assert.ok(user.properties.passwordHash.description.includes('设备本地'));

  const configuration = doc.components.schemas.SyncConfiguration;
  assert.deepEqual(configuration.required, [
    'heartbeatInterval',
    'telemetryInterval',
    'cameraRefreshInterval',
    'temperatureThreshold',
  ]);
  assert.equal(configuration.additionalProperties, false);

  const operational = doc.components.schemas.SyncOperationalStatus;
  assert.ok(operational.required.includes('syncIntervalSeconds'), 'Operational Status 必须含同步节奏');
  assert.deepEqual(operational.properties.connectivity.enum, ['ONLINE', 'OFFLINE']);
  assert.ok(operational.properties.lifecycleStatus.enum.includes('Retired'));

  // passwordHash 是源稿字段名，但只能表示设备本地验证值；私钥/证书材料/明文密码仍禁止。
  const all = JSON.stringify(doc.components.schemas);
  assert.ok(!/privateKey|certificatePem|packageCiphertext|plainPassword/i.test(all), '不得出现密钥材料/明文密码字段');
});

test('Retired 退役确认待处理设备仍可 Sync，契约不在认证层全局拒绝', () => {
  const docText = JSON.stringify(doc);
  assert.ok(!docText.includes('Retired 设备由 AUTH-03 拒绝'));
  assert.ok(doc.info['x-decision-versions'].includes('DEC-014@0.1.0'));
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
