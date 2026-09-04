/**
 * BE-DUSR-01 Admin Device User OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-device-user-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-device-user-api.json', import.meta.url), 'utf8'));
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

test('七个端点齐备且 Cognito 认证；写操作强制 If-Match', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected: [string, string, string, string[]][] = [
    ['/api/v1/admin/device-users', 'post', 'createDeviceUser', ['201', '400', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/device-users', 'get', 'listDeviceUsers', ['200', '400', '401', '403', '500']],
    ['/api/v1/admin/device-users/{deviceUserId}', 'get', 'getDeviceUser', ['200', '401', '403', '404', '500']],
    [
      '/api/v1/admin/device-users/{deviceUserId}',
      'patch',
      'updateDeviceUser',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/device-users/{deviceUserId}/disable',
      'post',
      'disableDeviceUser',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/device-users/{deviceUserId}/assignments',
      'post',
      'assignDeviceUser',
      ['201', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/device-users/{deviceUserId}/assignments/revoke',
      'post',
      'revokeDeviceUser',
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
  for (const [, , operationId] of expected.filter(([, , id]) =>
    ['updateDeviceUser', 'disableDeviceUser', 'assignDeviceUser', 'revokeDeviceUser'].includes(id),
  )) {
    const entry = expected.find(([, , id]) => id === operationId);
    const op = doc.paths[entry![0]]?.[entry![1]];
    const ifMatch = (op.parameters ?? []).find((p: { name?: string }) => p.name === 'If-Match');
    assert.ok(ifMatch?.required, `${operationId} 必须强制 If-Match`);
  }
});

test('Schema 封闭：管理 DTO 无 PHC；写接口只受控接收 writeOnly password', () => {
  const user = doc.components.schemas.DeviceUser;
  assert.equal(user.additionalProperties, false);
  assert.ok(
    !JSON.stringify(user).includes('verifierValue') && !JSON.stringify(user).includes('verifierSalt'),
    'DTO 不得含验证材料',
  );
  assert.ok(user.required.includes('version'), '同步版本');
  assert.deepEqual(user.properties.status.enum, ['ACTIVE', 'DISABLED']);
  const createReq = doc.components.schemas.DeviceUserCreateRequest;
  assert.equal(createReq.additionalProperties, false);
  assert.deepEqual(createReq.required.sort(), ['password', 'username']);
  assert.equal(createReq.properties.password.writeOnly, true);
  assert.ok(!('passwordHash' in createReq.properties));
  assert.ok(!('verifierValue' in createReq.properties));
  assert.equal(doc.components.schemas.DeviceUserUpdateRequest.properties.password.writeOnly, true);
  assert.deepEqual(doc.components.schemas.ReasonRequest.required, ['reason']);
  assert.deepEqual(doc.components.schemas.AssignmentRequest.required.sort(), ['deviceIds', 'reason'].sort());
  assert.deepEqual(doc.components.schemas.DeviceUserAssignment.properties.status.enum, ['ACTIVE', 'REVOKED']);
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
