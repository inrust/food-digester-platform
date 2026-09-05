/**
 * BE-RBAC-01 Admin User/Role/Scope OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-user-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-user-api.json', import.meta.url), 'utf8'));
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

test('端点齐备且 CognitoJwt 认证：列表/邀请/角色/scope/停用/密码重置', () => {
  assert.equal(doc.openapi, '3.1.0');
  const basePath = '/api/v1/admin/users';
  const expectations: Array<[string, string, string, string[]]> = [
    [basePath, 'get', 'listUsers', ['200', '400', '401', '403']],
    [basePath, 'post', 'inviteUser', ['201', '400', '401', '403', '404', '409']],
    [`${basePath}/{userId}/roles`, 'put', 'assignUserRoles', ['200', '400', '401', '403', '404', '409']],
    [`${basePath}/{userId}/scope`, 'put', 'setUserScope', ['200', '400', '401', '403', '404', '409']],
    [`${basePath}/{userId}/disable`, 'post', 'disableUser', ['200', '401', '403', '404', '409']],
    [`${basePath}/{userId}/password-reset`, 'post', 'triggerUserPasswordReset', ['200', '401', '403', '404']],
  ];
  for (const [path, method, operationId, codes] of expectations) {
    const op = doc.paths[path]?.[method];
    assert.ok(op, `缺少端点 ${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }], `${operationId} 必须 CognitoJwt`);
    for (const code of codes) {
      assert.ok(op.responses[code], `${operationId} 缺少响应码 ${code}`);
    }
  }
});

test('角色封闭集与 DEC-012 映射；输入不含密码字段；响应不含凭证材料', () => {
  assert.deepEqual(doc.components.schemas.RoleCode.enum, [
    'PlatformSuperAdmin',
    'PlatformOperator',
    'Auditor',
    'CustomerAdmin',
    'CustomerViewer',
  ]);

  const invite = doc.components.schemas.UserInvite;
  assert.equal(invite.additionalProperties, false);
  assert.deepEqual(invite.required, ['email', 'displayName', 'roles']);
  const inviteJson = JSON.stringify(invite.properties).toLowerCase();
  assert.ok(!inviteJson.includes('password'), '邀请输入不得包含密码字段');

  const view = doc.components.schemas.UserView;
  assert.equal(view.additionalProperties, false);
  const viewJson = JSON.stringify(view.properties).toLowerCase();
  for (const forbidden of ['password', 'cognitosub', 'secret', 'hash']) {
    assert.ok(!viewJson.includes(forbidden), `UserView 不得暴露 ${forbidden}`);
  }
  // 平台角色 customerId 恒为 null
  assert.deepEqual(view.properties.customerId.type, ['string', 'null']);

  const reset = doc.components.schemas.PasswordResetResult;
  const resetJson = JSON.stringify(reset.properties).toLowerCase();
  for (const forbidden of ['password', 'secret', 'temporarypassword', 'hash']) {
    assert.ok(!resetJson.includes(forbidden), `密码重置响应不得包含 ${forbidden}`);
  }
  assert.deepEqual(reset.required, ['userId', 'status']);
});

test('所有 $ref 可解析（内部引用 + openapi-base.json）', () => {
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
});
