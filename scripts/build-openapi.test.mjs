import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleOpenApi, run, validateOpenApiDocuments } from './build-openapi.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const REST_DIR = join(ROOT, 'contracts/rest');
const BUNDLE_PATH = join(REST_DIR, 'openapi.bundle.json');

function document(operationId = 'exampleOperation') {
  return {
    openapi: '3.1.0',
    info: { title: 'fixture', version: '1.0.0' },
    paths: {
      '/items/{itemId}': {
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId, responses: { 200: { description: 'ok' } } },
      },
    },
  };
}

test('真实 OpenAPI 片段可确定性打包且无外部引用', () => {
  const first = bundleOpenApi(REST_DIR);
  const second = bundleOpenApi(REST_DIR);
  assert.equal(first, second);
  const bundle = JSON.parse(first);
  assert.equal(bundle.openapi, '3.1.0');
  assert.equal(bundle.info['x-bundle-sources'].length, 25);
  assert.ok(Object.keys(bundle.paths).length > 80);
  assert.doesNotMatch(first, /openapi-base\.json#\//);
  const operations = Object.values(bundle.paths).flatMap((pathItem) =>
    Object.entries(pathItem)
      .filter(([method]) => ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method))
      .map(([, operation]) => operation),
  );
  assert.ok(operations.every((operation) => operation['x-source-document'] && operation['x-contract-status']));
});

test('bundle 新鲜度检查拒绝缺失或过期产物', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-openapi-bundle-'));
  const output = join(root, 'bundle.json');
  assert.equal(
    run(['--rest-dir', REST_DIR, '--output', output, '--check'], () => {}),
    1,
  );
  assert.equal(
    run(['--rest-dir', REST_DIR, '--output', output], () => {}),
    0,
  );
  assert.equal(
    run(['--rest-dir', REST_DIR, '--output', output, '--check'], () => {}),
    0,
  );
  writeFileSync(output, `${readFileSync(output, 'utf8')} `);
  assert.equal(
    run(['--rest-dir', REST_DIR, '--output', output, '--check'], () => {}),
    1,
  );
});

test('失败示例：非法 OpenAPI 版本与缺少 responses 被拒绝', () => {
  const invalidVersion = document();
  invalidVersion.openapi = '3.0.3';
  const missingResponses = document('missingResponses');
  delete missingResponses.paths['/items/{itemId}'].get.responses;
  const { errors } = validateOpenApiDocuments([
    { file: 'invalid-version.json', doc: invalidVersion },
    { file: 'missing-responses.json', doc: missingResponses },
  ]);
  assert.ok(errors.some((error) => error.includes('openapi 必须为 3.1.x')));
  assert.ok(errors.some((error) => error.includes('responses 必须为非空对象')));
});

test('失败示例：全局重复 operationId 被拒绝', () => {
  const { errors } = validateOpenApiDocuments([
    { file: 'a.json', doc: document('duplicateOperation') },
    { file: 'b.json', doc: document('duplicateOperation') },
  ]);
  assert.ok(errors.some((error) => error.includes('operationId duplicateOperation 重复')));
});

test('失败示例：非法 parameter 与 Schema 被拒绝', () => {
  const invalid = document();
  invalid.paths['/items/{itemId}'].parameters[0] = {
    name: 'itemId',
    in: 'body',
    required: false,
  };
  invalid.components = { schemas: { Broken: { type: 'strnig', required: 'id' } } };
  const { errors } = validateOpenApiDocuments([{ file: 'invalid.json', doc: invalid }]);
  assert.ok(errors.some((error) => error.includes('parameter 必须包含合法 name/in')));
  assert.ok(errors.some((error) => error.includes('Schema type 非法')));
  assert.ok(errors.some((error) => error.includes('Schema required 必须为字符串数组')));
});

test('仓库提交的统一 bundle 与当前片段一致', () => {
  assert.equal(readFileSync(BUNDLE_PATH, 'utf8'), bundleOpenApi(REST_DIR));
});
