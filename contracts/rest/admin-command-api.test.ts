/**
 * BE-CMD-01 Admin Command 创建与授权 OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-command-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-command-api.json', import.meta.url), 'utf8'));
const base = JSON.parse(readFileSync(new URL('./openapi-base.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('../mqtt/command-catalog.json', import.meta.url), 'utf8'));

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

test('端点齐备且 CognitoJwt 认证；201 创建 + 200 幂等重放 + 409 冲突/状态门', () => {
  assert.equal(doc.openapi, '3.1.0');
  const op = doc.paths['/api/v1/admin/devices/{deviceId}/commands'].post;
  assert.ok(op, '缺少创建端点');
  assert.equal(op.operationId, 'createDeviceCommand');
  assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
  for (const code of ['200', '201', '400', '401', '403', '404', '409']) {
    assert.ok(op.responses[code], `缺少响应码 ${code}`);
  }
});

test('命令枚举与 CT-04 目录 22 个白名单一致；确认凭证与 timeoutSec 边界齐备', () => {
  const names = doc.components.schemas.CommandName.enum;
  assert.equal(names.length, 22);
  assert.deepEqual([...names].sort(), catalog.commands.map((c: { command: string }) => c.command).sort());

  const create = doc.components.schemas.CommandCreate;
  assert.equal(create.additionalProperties, false);
  assert.deepEqual(create.required, ['command', 'timeoutSec']);
  assert.equal(create.properties.timeoutSec.minimum, 1);
  assert.equal(create.properties.timeoutSec.maximum, 3600);
  assert.ok(create.properties.confirmation, '高风险确认凭证字段缺失');

  const confirmation = doc.components.schemas.CommandConfirmation;
  assert.deepEqual(confirmation.required, ['confirmText', 'confirmedAt']);
  assert.equal(confirmation.additionalProperties, false);
});

test('响应 Schema 封闭且含 requestedBy/expiresAt/replayed/confirmedBy', () => {
  const view = doc.components.schemas.CommandView;
  assert.equal(view.additionalProperties, false);
  for (const field of ['requestedBy', 'expiresAt', 'replayed', 'confirmedBy', 'highRisk', 'status']) {
    assert.ok(view.required.includes(field), `CommandView 缺少 ${field}`);
  }
  assert.deepEqual(view.properties.status.enum, ['AUTHORIZED'], '创建即授权');
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
