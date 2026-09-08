import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DELIVERED_OPERATIONS } from '../apps/cloud-api/src/runtime/delivered-operations.ts';
import { compareDeliveredOperations, loadDeliveredOpenApiOperations } from './check-delivered-runtime.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('已交付 API（含 BE-CUS-01～02、BE-DEV-01～06）的 39 个 OpenAPI operation 与生产路由双向一致', () => {
  const openApi = loadDeliveredOpenApiOperations(ROOT);
  assert.equal(openApi.length, 39);
  assert.deepEqual(compareDeliveredOperations(openApi, DELIVERED_OPERATIONS), []);
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
