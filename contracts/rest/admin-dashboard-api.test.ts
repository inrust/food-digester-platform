/**
 * BE-DASH-01 Admin Dashboard OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-dashboard-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-dashboard-api.json', import.meta.url), 'utf8'));
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

test('端点齐备且 CognitoJwt 认证：仅 GET 总览（只读，无写路由）', () => {
  assert.equal(doc.openapi, '3.1.0');
  const paths = Object.keys(doc.paths);
  assert.deepEqual(paths, ['/api/v1/admin/dashboard/overview']);
  const methods = Object.keys(doc.paths[paths[0]]);
  assert.deepEqual(methods, ['get'], '总览仅允许 GET（聚合查询，不存在写路由）');
  const op = doc.paths[paths[0]].get;
  assert.equal(op.operationId, 'getDashboardOverview');
  assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
  for (const code of ['200', '401', '403']) {
    assert.ok(op.responses[code], `缺少响应码 ${code}`);
  }
});

test('总览 DTO 齐备：Contract/设备分布/在线率/今日 ESG/最新告警/设备卡片；四轴分离不合并', () => {
  const overview = doc.components.schemas.DashboardOverview;
  assert.equal(overview.additionalProperties, false);
  assert.deepEqual(overview.required, [
    'generatedAt',
    'contracts',
    'devices',
    'esgToday',
    'latestAlarms',
    'deviceCards',
  ]);

  // 指标定义固定：分母/时间窗口在描述中声明
  const devices = doc.components.schemas.DeviceSummary;
  assert.ok(devices.properties.online.description.includes('10 分钟'), '在线口径必须声明阈值');
  assert.ok(devices.properties.onlineRatePct.description.includes('online / total'), '在线率必须声明分母');
  const esg = doc.components.schemas.EsgTodaySummary;
  assert.ok(esg.properties.summaryDate.description.includes('UTC'), 'ESG 时间窗口必须声明 UTC 日');

  // DEC-010 四轴分离：卡片同时携带 lifecycle/operational/connectivity/license 四个独立字段
  const card = doc.components.schemas.DeviceCard;
  for (const axis of ['lifecycleStatus', 'operationalStatus', 'connectivity', 'licenseStatus']) {
    assert.ok(card.required.includes(axis), `设备卡片必须携带独立 ${axis} 轴`);
  }
  assert.ok(!('enabled' in card.properties), 'DEC-010：不得合并派生 enabled 单字段');

  // 卡片动作：只返回 command/allowed/denyReason（不执行命令）
  const action = doc.components.schemas.CommandAction;
  assert.deepEqual(action.required, ['command', 'allowed', 'denyReason']);
  assert.ok(action.properties.denyReason.enum.includes('FORBIDDEN'), 'denyReason 必须含权限拒绝码');

  // 运维指标边界：响应不得包含 AWS CPU/队列深度等字段
  const json = JSON.stringify(doc.components.schemas).toLowerCase();
  for (const forbidden of ['cpuusage', 'queuedepth', 'aws', 'arn:aws']) {
    assert.ok(!json.includes(forbidden), `总览 DTO 不得包含运维指标 ${forbidden}`);
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
