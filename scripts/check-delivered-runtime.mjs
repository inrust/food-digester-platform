#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DELIVERED_OPERATIONS } from '../apps/cloud-api/src/runtime/delivered-operations.ts';

const OPENAPI_FILES = [
  'device-onboarding-api.json',
  'device-certificate-api.json',
  'device-sync-api.json',
  'device-deactivate-api.json',
  'admin-onboarding-api.json',
  'admin-certificate-rotation-api.json',
  'admin-replay-api.json',
];
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const keyOf = (operation) => `${operation.operationId}|${operation.method}|${operation.path}`;

export function compareDeliveredOperations(openApiOperations, runtimeOperations) {
  const errors = [];
  const openApi = new Map();
  const runtime = new Map();
  for (const operation of openApiOperations) {
    if (openApi.has(operation.operationId)) errors.push(`OpenAPI operationId 重复: ${operation.operationId}`);
    openApi.set(operation.operationId, operation);
  }
  for (const operation of runtimeOperations) {
    if (runtime.has(operation.operationId)) errors.push(`生产路由 operationId 重复: ${operation.operationId}`);
    runtime.set(operation.operationId, operation);
  }
  for (const [operationId, operation] of openApi) {
    const actual = runtime.get(operationId);
    if (!actual) errors.push(`OpenAPI operation 缺少生产路由: ${operationId}`);
    else if (keyOf(actual) !== keyOf(operation)) {
      errors.push(
        `生产路由与 OpenAPI 不一致: ${operationId}，期望 ${operation.method} ${operation.path}，实际 ${actual.method} ${actual.path}`,
      );
    }
  }
  for (const operationId of runtime.keys()) {
    if (!openApi.has(operationId)) errors.push(`生产路由未在目标 OpenAPI 声明: ${operationId}`);
  }
  return errors;
}

export function loadDeliveredOpenApiOperations(root) {
  const restDir = resolve(root, 'contracts/rest');
  const operations = [];
  for (const file of OPENAPI_FILES) {
    const document = JSON.parse(readFileSync(resolve(restDir, file), 'utf8'));
    for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        operations.push({ operationId: operation.operationId, method: method.toUpperCase(), path });
      }
    }
  }
  return operations;
}

export function checkDeliveredRuntime(root = process.cwd()) {
  const errors = compareDeliveredOperations(loadDeliveredOpenApiOperations(root), DELIVERED_OPERATIONS);
  if (errors.length > 0) throw new Error(`已交付 REST 生产路由 Gate 失败：\n${errors.join('\n')}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  checkDeliveredRuntime(root);
  console.log(`已交付 REST 生产路由与 OpenAPI 双向一致（${DELIVERED_OPERATIONS.length} operations）`);
}
