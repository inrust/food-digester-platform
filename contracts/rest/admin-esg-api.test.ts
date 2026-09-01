/**
 * BE-ESG-02 Admin ESG 查询与 CSV 导出 OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-esg-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-esg-api.json', import.meta.url), 'utf8'));
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

test('八个端点齐备且 CognitoJwt 认证；导出创建返回 202', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected = [
    ['/api/v1/admin/esg/overview', 'get', 'getEsgOverview'],
    ['/api/v1/admin/esg/hourly', 'get', 'listEsgHourly'],
    ['/api/v1/admin/esg/daily', 'get', 'listEsgDaily'],
    ['/api/v1/admin/esg/reports', 'get', 'listEsgReports'],
    ['/api/v1/admin/esg/daily-summary', 'get', 'listEsgDailySummary'],
    ['/api/v1/admin/esg/calculation-versions', 'get', 'listEsgCalculationVersions'],
    ['/api/v1/admin/esg/exports', 'post', 'createEsgExport'],
    ['/api/v1/admin/esg/exports/{exportId}', 'get', 'getEsgExport'],
  ] as const;
  for (const [path, method, operationId] of expected) {
    const op = doc.paths[path][method];
    assert.ok(op, `缺少 ${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
  }
  assert.ok(doc.paths['/api/v1/admin/esg/exports'].post.responses['202'], '导出创建必须 202（异步入队）');
  assert.ok(doc.paths['/api/v1/admin/esg/exports/{exportId}'].get.responses['404'], '导出详情跨 Customer → 404');
});

test('查询筛选参数齐备（customerId/siteId/deviceId/时间范围 + 游标）；reports 含 reportType', () => {
  const names = (params: { name?: string; $ref?: string }[]) =>
    params.map((p) => p.name ?? p.$ref?.split('/').pop() ?? '');
  for (const path of ['/api/v1/admin/esg/hourly', '/api/v1/admin/esg/daily', '/api/v1/admin/esg/daily-summary']) {
    const ps = names(doc.paths[path].get.parameters);
    for (const name of ['CustomerId', 'SiteId', 'DeviceId', 'From', 'To', 'Cursor', 'Limit']) {
      assert.ok(ps.includes(name), `${path} 缺少 ${name}`);
    }
  }
  assert.ok(names(doc.paths['/api/v1/admin/esg/reports'].get.parameters).includes('reportType'));
});

test('Schema 封闭：导出数据集枚举、短期 URL 过期字段、CSV 一致性字段', () => {
  const create = doc.components.schemas.EsgExportCreate;
  assert.equal(create.additionalProperties, false);
  assert.deepEqual(create.required, ['dataset']);
  assert.deepEqual(create.properties.dataset.enum, ['HOURLY', 'DAILY', 'REPORTS', 'DAILY_SUMMARY']);

  const job = doc.components.schemas.EsgExportJob;
  for (const field of ['downloadUrl', 'urlExpiresAt', 'urlExpired', 'rowCount', 'status']) {
    assert.ok(job.required.includes(field), `EsgExportJob 缺少 ${field}`);
  }
  assert.equal(job.additionalProperties, false);

  // CSV 一致性：日汇总 Schema 字段覆盖完整率与计算版本引用
  const summary = doc.components.schemas.EsgDailySummary;
  assert.ok(summary.required.includes('dataCompletenessPct'));
  assert.ok(summary.required.includes('calculationVersionId'));

  // 查询响应 Schema 封闭
  for (const name of [
    'EsgHourly',
    'EsgDaily',
    'EsgReport',
    'EsgDailySummary',
    'EsgCalculationVersion',
    'EsgOverview',
  ]) {
    assert.equal(doc.components.schemas[name].additionalProperties, false, `${name} 必须封闭`);
  }
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
