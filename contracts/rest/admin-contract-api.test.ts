/**
 * BE-CON-01 Admin Contract OpenAPI 契约校验。
 * 运行：node --test "contracts/rest/admin-contract-api.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('./admin-contract-api.json', import.meta.url), 'utf8'));
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

test('八个端点齐备且 Cognito 认证；写操作强制 If-Match', () => {
  assert.equal(doc.openapi, '3.1.0');
  const expected: [string, string, string, string[]][] = [
    ['/api/v1/admin/contracts', 'post', 'createContract', ['201', '400', '401', '403', '404', '409', '500']],
    ['/api/v1/admin/contracts', 'get', 'listContracts', ['200', '400', '401', '403', '500']],
    ['/api/v1/admin/contracts/{contractId}', 'get', 'getContract', ['200', '401', '403', '404', '500']],
    [
      '/api/v1/admin/contracts/{contractId}',
      'patch',
      'updateContract',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/contracts/{contractId}/activate',
      'post',
      'activateContract',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/contracts/{contractId}/renew',
      'post',
      'renewContract',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/contracts/{contractId}/terminate',
      'post',
      'terminateContract',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
    [
      '/api/v1/admin/contracts/{contractId}/evaluate',
      'post',
      'evaluateContract',
      ['200', '400', '401', '403', '404', '409', '500'],
    ],
  ];
  for (const [path, method, operationId, statuses] of expected) {
    const op = doc.paths[path]?.[method];
    assert.ok(op, `缺少端点 ${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ CognitoJwt: [] }]);
    for (const status of statuses) assert.ok(op.responses[status], `${operationId} 缺少 ${status}`);
  }
  // 所有 If-Match 写操作声明 Header
  for (const [, , operationId] of expected.filter(
    ([, , id]) => id !== 'createContract' && id !== 'listContracts' && id !== 'getContract',
  )) {
    const entry = expected.find(([, , id]) => id === operationId);
    const op = doc.paths[entry![0]]?.[entry![1]];
    const ifMatch = (op.parameters ?? []).find((p: { name?: string }) => p.name === 'If-Match');
    assert.ok(ifMatch?.required, `${operationId} 必须强制 If-Match`);
  }
});

test('Schema 封闭：五态枚举/唯一编号/强制原因/派生状态/最小权限 contact', () => {
  const contract = doc.components.schemas.Contract;
  assert.equal(contract.additionalProperties, false);
  assert.deepEqual(contract.properties.status.enum, ['DRAFT', 'EFFECTIVE', 'EXPIRING_SOON', 'EXPIRED', 'TERMINATED']);
  assert.ok(contract.required.includes('derivedStatus'), '返回查询时点派生状态');
  assert.ok(contract.properties.contact.description.includes('最小权限'), 'contact 最小权限说明');
  const createReq = doc.components.schemas.ContractCreateRequest;
  assert.equal(createReq.additionalProperties, false);
  assert.deepEqual(createReq.required, ['contractNumber', 'name']);
  assert.ok(createReq.properties.contractNumber.description.includes('唯一'));
  const updateReq = doc.components.schemas.ContractUpdateRequest;
  assert.deepEqual(updateReq.required, ['reason'], '编辑强制原因');
  const renewReq = doc.components.schemas.ContractRenewRequest;
  assert.deepEqual(renewReq.required.sort(), ['reason']);
  const reasonReq = doc.components.schemas.ContractReasonRequest;
  assert.deepEqual(reasonReq.required, ['reason'], '激活/终止强制原因');
  const evalData = doc.components.schemas.ContractEvaluateSuccess.properties.data;
  assert.ok(JSON.stringify(evalData).includes('"changed"'), 'evaluate 响应含变化标记');
});

test('R11 写入支持日期及旧时间戳，同一边界只允许一种表示', () => {
  const { ContractBusinessDate, ContractCreateRequest, ContractUpdateRequest, ContractRenewRequest, Contract } =
    doc.components.schemas;
  assert.equal(ContractBusinessDate.format, 'date');
  assert.deepEqual(ContractCreateRequest.allOf.slice(1), [
    { oneOf: [{ required: ['startDate'] }, { required: ['startAt'] }] },
    { oneOf: [{ required: ['endDate'] }, { required: ['endAt'] }] },
  ]);
  assert.deepEqual(ContractUpdateRequest.not.anyOf, [
    { required: ['startAt', 'startDate'] },
    { required: ['endAt', 'endDate'] },
  ]);
  assert.deepEqual(ContractRenewRequest.oneOf, [{ required: ['newEndDate'] }, { required: ['newEndAt'] }]);
  for (const request of [ContractCreateRequest, ContractUpdateRequest]) {
    for (const key of ['startDate', 'endDate']) {
      assert.equal(request.properties[key].$ref, '#/components/schemas/ContractBusinessDate');
    }
  }
  assert.equal(ContractRenewRequest.properties.newEndDate.$ref, '#/components/schemas/ContractBusinessDate');
  for (const key of ['startAt', 'endAt']) {
    assert.equal(Contract.properties[key].$ref, 'openapi-base.json#/components/schemas/UtcTimestamp');
  }
});

test('R12 既有客户 ID 与内联客户二选一，R16 可按唯一合同编号精确查询', () => {
  const { ContractCreateRequest } = doc.components.schemas;
  assert.deepEqual(ContractCreateRequest.allOf[0], {
    oneOf: [{ required: ['customerId'] }, { required: ['newCustomer'] }],
  });
  const { newCustomer } = ContractCreateRequest.properties;
  assert.equal(newCustomer.additionalProperties, false);
  assert.deepEqual(newCustomer.required, ['name']);
  assert.equal(newCustomer.properties.allowDuplicateName.default, false);
  const { get, post } = doc.paths['/api/v1/admin/contracts'];
  const lookup = get.parameters.find((parameter: { name: string }) => parameter.name === 'contractNumber');
  assert.equal(lookup.in, 'query');
  assert.equal(lookup.schema.type, 'string');
  assert.equal(post.responses['409'].$ref, '#/components/responses/Conflict');
  assert.ok(post.description.includes('重复合同编号返回 409'));
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
