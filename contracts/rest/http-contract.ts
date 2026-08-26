/**
 * CT-05 REST 通用契约：DTO、异常映射器、游标分页、幂等与并发助手。
 *
 * 与 NestJS/Lambda handler 共享：纯函数、无框架依赖。
 * 事实源：contracts/rest/openapi-base.json 与 error-codes.json（一致性由测试强制）。
 * 决策追溯：ADP-001@1.0.0（身份由服务端上下文注入）。
 *
 * 功能边界：不实现业务接口。
 */

// ---------- 错误码 ----------

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'CURSOR_INVALID'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DEVICE_STATE_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  CURSOR_INVALID: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DEVICE_STATE_NOT_ALLOWED: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

/** 对外安全的默认消息（不含内部实现细节）。 */
export const ERROR_DEFAULT_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'The request failed validation',
  CURSOR_INVALID: 'The pagination cursor is invalid',
  IDEMPOTENCY_KEY_REQUIRED: 'The Idempotency-Key header is required for this operation',
  UNAUTHENTICATED: 'Authentication is required or the credential is invalid',
  FORBIDDEN: 'The caller is not allowed to perform this operation',
  NOT_FOUND: 'The requested resource was not found',
  CONFLICT: 'The request conflicts with the current state of the resource',
  VERSION_CONFLICT: 'The resource was modified concurrently; refresh and retry',
  IDEMPOTENCY_CONFLICT: 'The Idempotency-Key was already used with a different request body',
  DEVICE_STATE_NOT_ALLOWED: 'The operation is not allowed in the current device state',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: 'Internal server error',
} as const;

/** 业务异常。message 必须是对客户端安全的文本；内部细节只允许进日志上下文。 */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_DEFAULT_MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

// ---------- DTO ----------

export interface ResponseMeta {
  readonly requestId: string;
  /** UTC ISO 8601，以 Z 结尾。 */
  readonly timestamp: string;
}

export interface SuccessResponse<T> {
  readonly data: T;
  readonly meta: ResponseMeta;
}

export interface PageResponse<T> {
  readonly data: readonly T[];
  readonly meta: ResponseMeta & { readonly nextCursor: string | null };
}

export interface ErrorResponse {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
  };
}

export interface RequestContext {
  readonly requestId: string;
  /** 注入时钟，默认当前 UTC 时间。 */
  readonly now?: () => Date;
}

function utcTimestamp(ctx: RequestContext): string {
  return (ctx.now?.() ?? new Date()).toISOString();
}

export function ok<T>(data: T, ctx: RequestContext): SuccessResponse<T> {
  return { data, meta: { requestId: ctx.requestId, timestamp: utcTimestamp(ctx) } };
}

export function page<T>(items: readonly T[], nextCursor: string | null, ctx: RequestContext): PageResponse<T> {
  return { data: items, meta: { requestId: ctx.requestId, timestamp: utcTimestamp(ctx), nextCursor } };
}

// ---------- 异常映射器 ----------

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

/**
 * 把任意异常映射为安全错误响应。
 * - ApiError：使用其 code 与 message（message 必须安全，构造方负责）；
 * - 其他异常：一律映射为 INTERNAL_ERROR 通用消息，绝不回传原始 message/stack。
 */
export function toErrorResponse(err: unknown, ctx: RequestContext): { status: number; body: ErrorResponse } {
  if (err instanceof ApiError) {
    const safe = SENSITIVE_LEAK_PATTERN.test(err.message) ? ERROR_DEFAULT_MESSAGE[err.code] : err.message;
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: safe, requestId: ctx.requestId } },
    };
  }
  return {
    status: 500,
    body: {
      error: { code: 'INTERNAL_ERROR', message: ERROR_DEFAULT_MESSAGE.INTERNAL_ERROR, requestId: ctx.requestId },
    },
  };
}

// ---------- Header 常量与校验 ----------

export const HEADER_IDEMPOTENCY_KEY = 'Idempotency-Key' as const;
export const HEADER_IF_MATCH = 'If-Match' as const;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

/** 写操作幂等键：缺失或非法抛出 ApiError（IDEMPOTENCY_KEY_REQUIRED / VALIDATION_FAILED）。 */
export function requireIdempotencyKey(value: string | undefined | null): string {
  if (value === undefined || value === null || value === '') {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiError('VALIDATION_FAILED', 'The Idempotency-Key header has an invalid format');
  }
  return value;
}

/** 解析 If-Match 版本号；缺失或非法抛出 ApiError。 */
export function parseIfMatch(value: string | undefined | null): number {
  if (value === undefined || value === null || value === '') {
    throw new ApiError('VALIDATION_FAILED', 'The If-Match header is required for this operation');
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw new ApiError('VALIDATION_FAILED', 'The If-Match header must be a non-negative integer version');
  }
  return version;
}

/** 并发版本校验：不一致抛 VERSION_CONFLICT（409）。 */
export function assertVersionMatch(ifMatchVersion: number, currentVersion: number): void {
  if (ifMatchVersion !== currentVersion) {
    throw new ApiError('VERSION_CONFLICT');
  }
}

// ---------- 游标分页 ----------

interface CursorPayload {
  /** 已跳过的记录数（偏移式游标，Repository 层在 DB-02 落地时可替换为键集）。 */
  readonly o: number;
  /** 签发时的版本戳，防止游标跨不兼容查询复用。 */
  readonly v: 1;
}

/** 生成不透明游标（base64url JSON）。 */
export function encodeCursor(offset: number): string {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError('VALIDATION_FAILED', 'Cursor offset must be a non-negative integer');
  }
  const payload: CursorPayload = { o: offset, v: 1 };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** 解析游标；非法输入抛出 CURSOR_INVALID（400），不暴露内部结构。 */
export function decodeCursor(cursor: string | undefined | null): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (parsed.v !== 1 || !Number.isInteger(parsed.o) || (parsed.o as number) < 0) {
      throw new Error('bad cursor payload');
    }
    return parsed.o as number;
  } catch {
    throw new ApiError('CURSOR_INVALID');
  }
}

/** limit 参数归一化：默认 50，范围 1~100。 */
export function parseLimit(value: string | undefined | null): number {
  if (value === undefined || value === null || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError('VALIDATION_FAILED', 'The limit parameter must be an integer between 1 and 100');
  }
  return limit;
}
