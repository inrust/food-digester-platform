import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DELIVERED_OPERATIONS } from '../apps/cloud-api/src/runtime/delivered-operations.ts';
import {
  checkDeliveredRuntime,
  compareDeliveredOperations,
  findCmdOtaGovernanceErrors,
  loadDeliveredOpenApiManifest,
  loadDeliveredOpenApiOperations,
} from './check-delivered-runtime.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('已交付 API（含 CMD/OTA P1）的 112 个 OpenAPI operation 与生产路由双向一致', () => {
  assert.equal(loadDeliveredOpenApiManifest(ROOT).length, 27);
  const openApi = loadDeliveredOpenApiOperations(ROOT);
  assert.equal(openApi.length, 112);
  assert.deepEqual(compareDeliveredOperations(openApi, DELIVERED_OPERATIONS), []);
});

test('版本化已交付清单缺失、重复或引用不存在文件时失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-runtime-manifest-'));
  const rest = join(root, 'contracts/rest');
  mkdirSync(rest, { recursive: true });
  assert.throws(() => loadDeliveredOpenApiManifest(root), /缺少已交付 OpenAPI 清单/u);

  writeFileSync(
    join(rest, 'delivered-openapi-manifest.json'),
    JSON.stringify({ schemaVersion: '1.0', kind: 'delivered-openapi-manifest', openApiFiles: ['missing-api.json'] }),
  );
  assert.throws(() => loadDeliveredOpenApiManifest(root), /文件不存在/u);

  writeFileSync(join(rest, 'sample-api.json'), JSON.stringify({ paths: {} }));
  writeFileSync(
    join(rest, 'delivered-openapi-manifest.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      kind: 'delivered-openapi-manifest',
      openApiFiles: ['sample-api.json', 'sample-api.json'],
    }),
  );
  assert.throws(() => loadDeliveredOpenApiManifest(root), /重复文件/u);
});

test('缺失、额外、重复及 method/path 漂移均失败关闭', () => {
  const expected = [{ operationId: 'syncDevice', method: 'POST', path: '/api/v1/device/sync' }];
  assert.match(compareDeliveredOperations(expected, [])[0], /缺少生产路由/u);
  assert.match(
    compareDeliveredOperations(expected, [
      ...expected,
      { operationId: 'unexpected', method: 'GET', path: '/unexpected' },
    ])[0],
    /未在目标 OpenAPI 声明/u,
  );
  assert.ok(compareDeliveredOperations([...expected, ...expected], expected).some((error) => /重复/u.test(error)));
  assert.match(
    compareDeliveredOperations(expected, [{ operationId: 'syncDevice', method: 'GET', path: '/wrong' }])[0],
    /不一致/u,
  );
});

test('CMD/OTA 治理 Gate 校验四份 REST 契约及 DEC-022/023 冻结状态', () => {
  assert.doesNotThrow(() => checkDeliveredRuntime(ROOT));
  const manifest = ['admin-command-api.json', 'admin-ota-package-api.json', 'admin-ota-campaign-api.json'];
  const policy = { status: 'provisional', policyVersion: '0.1.0', pendingParameters: ['signature.algorithm'] };
  const decisions = { decisions: [{ id: 'DEC-023', version: '0.1.0', status: 'pending' }] };
  const errors = findCmdOtaGovernanceErrors(manifest, policy, decisions);
  assert.ok(
    errors.some((error) => /device-ota-api/u.test(error)),
    '缺失任一 CMD/OTA REST 契约必须失败',
  );
  assert.ok(
    errors.some((error) => /DEC-022/u.test(error)),
    '签名未冻结必须失败',
  );
  assert.ok(
    errors.some((error) => /DEC-023/u.test(error)),
    '高风险确认未冻结必须失败',
  );
});
