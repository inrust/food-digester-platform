/**
 * ENG-02 check-schemas 失败示例测试。
 * 运行：node --test scripts/check-schemas.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSchemas, checkSchemaFile } from './check-schemas.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'fdp-schemas-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test('当前仓库全部 Schema 与 OpenAPI 基座通过校验', () => {
  const root = new URL('..', import.meta.url).pathname;
  assert.deepEqual(checkSchemas(root), []);
});

test('失败示例：悬空内部 $ref 被拒绝', () => {
  const root = fixture({
    'contracts/a.schema.json': JSON.stringify({
      type: 'object',
      properties: { x: { $ref: '#/definitions/missing' } },
    }),
  });
  const errors = checkSchemas(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\$ref 目标不存在/);
});

test('失败示例：同目录相对 $ref 目标文件不存在被拒绝', () => {
  const root = fixture({
    'contracts/a.schema.json': JSON.stringify({ $ref: 'ghost.schema.json#/definitions/x' }),
  });
  const errors = checkSchemas(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /目标文件不存在/);
});

test('失败示例：JSON 语法损坏的 Schema 被拒绝', () => {
  const root = fixture({ 'contracts/b.schema.json': '{ not json' });
  const errors = checkSchemas(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /JSON 解析失败/);
});

test('失败示例：OpenAPI 基座缺少 paths 被拒绝', () => {
  const root = fixture({
    'contracts/rest/openapi-base.json': JSON.stringify({ openapi: '3.1.0', info: {} }),
  });
  const errors = checkSchemas(root);
  assert.ok(errors.some((e) => e.includes('缺少 OpenAPI 必填顶层字段 paths')));
});

test('同目录相对 $ref 可解析时通过', () => {
  const root = fixture({
    'contracts/common.schema.json': JSON.stringify({ definitions: { id: { type: 'string' } } }),
    'contracts/a.schema.json': JSON.stringify({
      type: 'object',
      properties: { id: { $ref: 'common.schema.json#/definitions/id' } },
    }),
  });
  assert.deepEqual(checkSchemas(root), []);
  assert.deepEqual(checkSchemaFile(join(root, 'contracts/a.schema.json')), []);
});
