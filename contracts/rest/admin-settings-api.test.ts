/**
 * BE-SET-01 Admin Settings OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-settings-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-settings-api.json', import.meta.url), 'utf8'));
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

test('端点齐备且 CognitoJwt 认证：列表/读取/更新（无删除与新建路由）', () => {
  assert.equal(doc.openapi, '3.1.0');
  const list = doc.paths['/api/v1/admin/settings'];
  assert.deepEqual(Object.keys(list), ['get'], '列表仅 GET（封闭 key 集，无新建）');
  assert.equal(list.get.operationId, 'listSettings');
  assert.deepEqual(list.get.security, [{ CognitoJwt: [] }]);

  const item = doc.paths['/api/v1/admin/settings/{key}'];
  assert.deepEqual(Object.keys(item).sort(), ['get', 'put'], '单项仅 GET/PUT（无删除——固定 key 不可删除）');
  assert.equal(item.get.operationId, 'getSetting');
  assert.equal(item.put.operationId, 'updateSetting');
  assert.deepEqual(item.put.security, [{ CognitoJwt: [] }]);
  for (const code of ['200', '400', '401', '403', '404', '409']) {
    assert.ok(item.put.responses[code], `updateSetting 缺少响应码 ${code}`);
  }
});

test('封闭 key 集与乐观锁版本控制；固定枚举不可经 API 改写', () => {
  assert.deepEqual(doc.components.schemas.SettingKey.enum, [
    'alarm.thresholds',
    'command.confirmation',
    'dictionary.displayNames',
    'notification.business',
  ]);

  // 乐观锁：更新输入必须携带 version；视图暴露 version
  const update = doc.components.schemas.SettingUpdate;
  assert.equal(update.additionalProperties, false);
  assert.deepEqual(update.required, ['value', 'version']);
  assert.ok(doc.components.schemas.SettingView.required.includes('version'));

  // 契约不含任何改写固定协议枚举/Topic/AWS 运维配置的入口
  const json = JSON.stringify(doc.paths).toLowerCase();
  for (const forbidden of ['topic-catalog', 'command-catalog', 'cloudwatch', 'budget', 'aws/']) {
    assert.ok(!json.includes(forbidden), `契约不得暴露固定枚举/运维配置入口 ${forbidden}`);
  }
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
