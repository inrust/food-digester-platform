/**
 * CT-05 REST 通用契约中间件测试。
 * 运行：node --test "contracts/rest/http-contract.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ApiError,
  ERROR_DEFAULT_MESSAGE,
  ERROR_HTTP_STATUS,
  HEADER_IDEMPOTENCY_KEY,
  HEADER_IF_MATCH,
  assertVersionMatch,
  decodeCursor,
  encodeCursor,
  ok,
  page,
  parseIfMatch,
  parseLimit,
  requireIdempotencyKey,
  toErrorResponse,
  type ErrorCode,
} from './http-contract.ts';

const openapi = JSON.parse(readFileSync(new URL('./openapi-base.json', import.meta.url), 'utf8'));
const errorCatalog = JSON.parse(readFileSync(new URL('./error-codes.json', import.meta.url), 'utf8'));

const ctx = { requestId: 'req-test-1', now: () => new Date('2026-08-26T08:00:00Z') };

/** 捕获 ApiError；未抛出或类型不符则断言失败。 */
function catchApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `期望 ApiError，实际 ${String(err)}`);
    return err;
  }
  assert.fail('应抛出 ApiError');
}

test('成功响应结构：data + meta(requestId, UTC timestamp)', () => {
  const res = ok({ id: 1 }, ctx);
  assert.deepEqual(res.data, { id: 1 });
  assert.equal(res.meta.requestId, 'req-test-1');
  assert.match(res.meta.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
});

test('游标分页响应与往返解析', () => {
  const cursor = encodeCursor(50);
  const res = page([1, 2], cursor, ctx);
  assert.equal(res.meta.nextCursor, cursor);
  assert.equal(decodeCursor(cursor), 50);
  assert.equal(decodeCursor(undefined), 0);
  assert.equal(decodeCursor(''), 0);
  const empty = page([], null, ctx);
  assert.equal(empty.meta.nextCursor, null);
});

test('非法游标返回 CURSOR_INVALID（400）', () => {
  for (const bad of [
    'not-base64!!!',
    Buffer.from('{"o":-1,"v":1}').toString('base64url'),
    Buffer.from('{"o":0,"v":2}').toString('base64url'),
  ]) {
    const err = catchApiError(() => decodeCursor(bad));
    assert.equal(err.code, 'CURSOR_INVALID');
    assert.equal(err.httpStatus, 400);
  }
});

test('limit 归一化：默认 50，范围 1~100', () => {
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('100'), 100);
  for (const bad of ['0', '101', '1.5', 'abc']) {
    assert.equal(catchApiError(() => parseLimit(bad)).code, 'VALIDATION_FAILED');
  }
});

test('Idempotency-Key：缺失/非法被拒绝，合法值透传', () => {
  assert.equal(HEADER_IDEMPOTENCY_KEY, 'Idempotency-Key');
  assert.equal(catchApiError(() => requireIdempotencyKey(undefined)).code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(catchApiError(() => requireIdempotencyKey('bad key!')).code, 'VALIDATION_FAILED');
  assert.equal(requireIdempotencyKey('req-abc:123'), 'req-abc:123');
});

test('If-Match 并发版本冲突返回确定的 409', () => {
  assert.equal(HEADER_IF_MATCH, 'If-Match');
  assert.equal(parseIfMatch('3'), 3);
  assert.equal(catchApiError(() => parseIfMatch(undefined)).code, 'VALIDATION_FAILED');
  assert.equal(catchApiError(() => parseIfMatch('x')).code, 'VALIDATION_FAILED');
  assert.doesNotThrow(() => assertVersionMatch(3, 3));
  const err = catchApiError(() => assertVersionMatch(2, 3));
  assert.equal(err.code, 'VERSION_CONFLICT');
  assert.equal(err.httpStatus, 409);
  const res = toErrorResponse(err, ctx);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VERSION_CONFLICT');
});

test('验证失败有确定响应（400 + VALIDATION_FAILED）', () => {
  const res = toErrorResponse(new ApiError('VALIDATION_FAILED'), ctx);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    error: { code: 'VALIDATION_FAILED', message: ERROR_DEFAULT_MESSAGE.VALIDATION_FAILED, requestId: 'req-test-1' },
  });
});

test('异常映射器不泄露堆栈、SQL 或 AWS 内部错误', () => {
  // 未知异常：一律 500 + 通用消息
  const internal = toErrorResponse(new Error('SELECT * FROM users failed at pg.js:42\n  at stack frame'), ctx);
  assert.equal(internal.status, 500);
  assert.equal(internal.body.error.code, 'INTERNAL_ERROR');
  assert.equal(internal.body.error.message, ERROR_DEFAULT_MESSAGE.INTERNAL_ERROR);
  assert.ok(!JSON.stringify(internal.body).includes('SELECT'));

  // ApiError 携带了含敏感词的 message 时被替换为默认安全消息
  const leaky = toErrorResponse(new ApiError('CONFLICT', 'duplicate key in SQL insert'), ctx);
  assert.equal(leaky.body.error.code, 'CONFLICT');
  assert.equal(leaky.body.error.message, ERROR_DEFAULT_MESSAGE.CONFLICT);

  // 非 Error 抛出物同样被兜底
  const weird = toErrorResponse('arn:aws:rds:... access denied', ctx);
  assert.equal(weird.status, 500);
});

test('错误码目录、HTTP 状态映射与 OpenAPI ErrorCode 枚举三者一致', () => {
  const catalogCodes = errorCatalog.errorCodes.map((e: { code: string }) => e.code).sort();
  const tsCodes = Object.keys(ERROR_HTTP_STATUS).sort();
  const openApiCodes = [...openapi.components.schemas.ErrorCode.enum].sort();
  assert.deepEqual(tsCodes, catalogCodes);
  assert.deepEqual(openApiCodes, catalogCodes);
  // HTTP 状态与目录一致
  for (const entry of errorCatalog.errorCodes) {
    assert.equal(ERROR_HTTP_STATUS[entry.code as ErrorCode], entry.httpStatus, entry.code);
  }
  // 每个错误码都有对外安全默认消息
  for (const code of catalogCodes) {
    assert.ok(ERROR_DEFAULT_MESSAGE[code as ErrorCode].length > 0, code);
  }
});

test('OpenAPI 基座结构有效：四个 API 分组与安全方案', () => {
  assert.equal(openapi.openapi, '3.1.0');
  const tags = openapi.tags.map((t: { name: string; 'x-path-prefix': string }) => [t.name, t['x-path-prefix']]);
  assert.deepEqual(tags, [
    ['device', '/api/v1/device'],
    ['admin', '/api/v1/admin'],
    ['customer', '/api/v1/customer'],
    ['internal', '/api/v1/internal'],
  ]);
  assert.ok(openapi.components.securitySchemes.DeviceMtls);
  assert.ok(openapi.components.securitySchemes.CognitoJwt);
  assert.ok(openapi.components.securitySchemes.InternalKey);
  assert.ok(openapi.components.parameters.IdempotencyKey.required);
  assert.ok(openapi.components.parameters.IfMatch.required);
  assert.ok(openapi.info['x-decision-register-version']);
});

test('OpenAPI 基座所有内部 $ref 均可解析（无悬空引用）', () => {
  const refs: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        else walk(v);
      }
    }
  };
  walk(openapi);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(ref.startsWith('#/'), `仅允许内部引用: ${ref}`);
    let node: unknown = openapi;
    for (const seg of ref.slice(2).split('/')) {
      node = (node as Record<string, unknown>)[seg];
    }
    assert.ok(node !== undefined, `悬空引用: ${ref}`);
  }
});
