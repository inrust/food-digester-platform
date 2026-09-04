/**
 * BE-CFG-01 Admin Configuration OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-configuration-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-configuration-api.json', import.meta.url), 'utf8'));
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

test('七个端点齐备且 Cognito 认证；operationId 与响应码齐备', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected: [string, string, string, string[]][] = [
    ['/api/v1/admin/configurations', 'post', 'createConfiguration', ['201', '400', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/configurations', 'get', 'listConfigurations', ['200', '401', '403', '500']],
    ['/api/v1/admin/configurations/{configurationId}', 'get', 'getConfiguration', ['200', '401', '403', '404', '500']],
    [
      '/api/v1/admin/configurations/{configurationId}/versions',
      'post',
      'createConfigurationVersion',
      ['201', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/configurations/{configurationId}/versions/{version}/publish',
      'post',
      'publishConfigurationVersion',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/configurations/{configurationId}/versions/{version}',
      'get',
      'getConfigurationVersion',
      ['200', '401', '403', '404', '500'],
    ],
    [
      '/api/v1/admin/configurations/{configurationId}/versions/{version}/status',
      'get',
      'getConfigurationVersionStatus',
      ['200', '401', '403', '404', '500'],
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

test('Schema 封闭：V1 只允许源稿四字段，候选扩展在 DEC-018 冻结前拒绝', () => {
  const payload = doc.components.schemas.ConfigurationPayload;
  assert.equal(payload.additionalProperties, false);
  assert.deepEqual(
    [...payload.required].sort(),
    ['heartbeatInterval', 'telemetryInterval', 'cameraRefreshInterval', 'temperatureThreshold'].sort(),
  );
  for (const rejected of ['image', 'rotation', 'motor', 'heating', 'language', 'cloudDomain', 'ntpServer']) {
    assert.ok(!(rejected in payload.properties), `${rejected} 在 DEC-018 冻结前不得进入 V1`);
  }
  assert.ok(doc.info['x-decision-versions'].includes('DEC-018@0.1.0'));
  // 版本不可变：无 payload 更新端点
  const version = doc.components.schemas.ConfigurationVersion;
  assert.equal(version.additionalProperties, false);
  assert.deepEqual(version.properties.status.enum, ['DRAFT', 'PUBLISHED']);
  assert.ok(!JSON.stringify(doc.paths).includes('"put"'), '版本无 PUT 更新路径');
  assert.ok(!JSON.stringify(doc.paths).includes('"patch"'), '版本无 PATCH 更新路径');
  // 创建目标二选一说明
  const createReq = doc.components.schemas.ConfigurationCreateRequest;
  assert.equal(createReq.additionalProperties, false);
  assert.ok(createReq.description.includes('只能提供一个'));
  // 发布结果与同步状态
  const publishResult = doc.components.schemas.ConfigurationPublishResult;
  assert.deepEqual(publishResult.required.sort(), ['notifiedDeviceIds', 'version'].sort());
  const syncTarget = doc.components.schemas.ConfigurationSyncStatusTarget;
  assert.deepEqual(syncTarget.properties.notificationStatus.enum, ['PENDING', 'PUBLISHED', 'FAILED']);
  // 派生只读上下文
  const detail = doc.components.schemas.ConfigurationDetail;
  assert.ok(detail.required.includes('derivedContext'));
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
