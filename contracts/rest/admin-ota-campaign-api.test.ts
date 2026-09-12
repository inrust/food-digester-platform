/**
 * BE-OTA-02 Admin OTA Campaign OpenAPI 契约校验。
 * 运行：node --import tsx --test contracts/rest/admin-ota-campaign-api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-ota-campaign-api.json', import.meta.url), 'utf8'));
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

test('端点齐备且 CognitoJwt 认证：创建/列表/详情/targets/扩大批次/pause/resume/cancel/retry', () => {
  assert.equal(doc.openapi, '3.1.0');
  const base_ = '/api/v1/admin/ota/campaigns';
  const expectations: Array<[string, string, string, string[]]> = [
    [base_, 'post', 'createOtaCampaign', ['201', '400', '401', '403', '404']],
    [base_, 'get', 'listOtaCampaigns', ['200', '400', '401', '403']],
    [`${base_}/{campaignId}`, 'get', 'getOtaCampaign', ['200', '401', '403', '404']],
    [`${base_}/{campaignId}/targets`, 'get', 'listOtaTargets', ['200', '400', '401', '403', '404']],
    [`${base_}/{campaignId}/batches`, 'post', 'expandOtaCampaignBatch', ['201', '400', '401', '403', '404', '409']],
    [`${base_}/{campaignId}/pause`, 'post', 'pauseOtaCampaign', ['200', '401', '403', '404', '409']],
    [`${base_}/{campaignId}/resume`, 'post', 'resumeOtaCampaign', ['200', '401', '403', '404', '409']],
    [`${base_}/{campaignId}/cancel`, 'post', 'cancelOtaCampaign', ['200', '401', '403', '404', '409']],
    [`${base_}/{campaignId}/retry`, 'post', 'retryOtaCampaignFailures', ['200', '400', '401', '403', '404', '409']],
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

test('首批强制恰好 1 台；最终全量审批契约封闭；状态机枚举封闭', () => {
  const create = doc.components.schemas.OtaCampaignCreate;
  assert.equal(create.additionalProperties, false);
  assert.deepEqual(create.required, ['name', 'packageId', 'deviceIds']);
  assert.equal(create.properties.deviceIds.minItems, 1);
  assert.equal(create.properties.deviceIds.maxItems, 1, '首批强制恰好 1 台');
  const expand = doc.components.schemas.OtaBatchExpand;
  assert.equal(expand.properties.deviceIds.maxItems, 500, '单批最多 500 台');
  assert.equal(expand.properties.finalRolloutApproval.$ref, '#/components/schemas/FinalRolloutApproval');
  assert.deepEqual(doc.components.schemas.FinalRolloutApproval.required, ['confirmText']);
  assert.equal(doc.components.schemas.FinalRolloutApproval.additionalProperties, false);

  assert.deepEqual(doc.components.schemas.OtaCampaignStatus.enum, [
    'DRAFT',
    'RUNNING',
    'PAUSED',
    'COMPLETED',
    'CANCELLED',
  ]);
  assert.deepEqual(doc.components.schemas.OtaTargetStatus.enum, [
    'PENDING',
    'NOTIFIED',
    'DOWNLOADING',
    'INSTALLING',
    'SUCCEEDED',
    'FAILED',
    'ROLLED_BACK',
    'CANCELLED',
  ]);
  assert.deepEqual(
    doc.components.schemas.OtaCampaignView.properties.strategy.enum,
    ['CANARY', 'BATCH'],
    '最终扩批仍使用受控 BATCH，不引入无审批 FULL/ALL 策略',
  );
});

test('视图封闭且不泄露内部字段；批次/重试结果结构稳定', () => {
  for (const name of [
    'OtaCampaignCreate',
    'OtaBatchExpand',
    'FinalRolloutApproval',
    'OtaRetryRequest',
    'OtaCampaignView',
    'OtaCampaignDetailView',
    'OtaTargetView',
    'OtaBatchExpandResult',
    'OtaRetryResult',
  ]) {
    assert.equal(doc.components.schemas[name].additionalProperties, false, `${name} 必须封闭`);
  }
  const detail = doc.components.schemas.OtaCampaignDetailView;
  assert.ok(detail.required.includes('targetCounts'), '详情须含状态计数看板');
  assert.equal(detail.properties.targetCounts.additionalProperties, false);
  const expand = doc.components.schemas.OtaBatchExpandResult;
  assert.ok(expand.required.includes('skippedExistingCount'), '扩大批次须报告幂等跳过数');
  assert.ok(expand.required.includes('finalRolloutApproved'), '扩大批次须报告最终全量审批事实');
  assert.equal(expand.properties.batchNo.minimum, 2, '扩大批次 batchNo 从 2 起（1 = 灰度批次）');
  const target = doc.components.schemas.OtaTargetView;
  assert.ok(target.required.includes('failureCode'));
  assert.ok(target.required.includes('failureReason'));
  assert.equal(target.properties.failureCode.type[1], 'null');
  assert.equal(target.properties.failureCode.maxLength, 64);
  assert.equal(target.properties.failureReason.type[1], 'null');
  assert.equal(target.properties.failureReason.maxLength, 500);
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
