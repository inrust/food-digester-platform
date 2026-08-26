/**
 * DB-02 数据库基础库语义化错误。
 * 不依赖 REST 契约层；HTTP 映射由 mapDbErrorToHttp 提供，API 层据此返回 CT-05 错误码。
 */

export class DbError extends Error {
  override readonly name: string = 'DbError';
}

/** Customer 业务查询缺少 customer scope（编程错误；API 层身份上下文必须注入）。 */
export class ScopeRequiredError extends DbError {
  override readonly name = 'ScopeRequiredError';
  constructor(readonly model: string) {
    super(`Customer scope is required for ${model}`);
  }
}

export class RecordNotFoundError extends DbError {
  override readonly name = 'RecordNotFoundError';
  constructor(
    readonly model: string,
    readonly id: string,
  ) {
    super(`${model} ${id} not found`);
  }
}

/** 乐观锁版本冲突（对应 HTTP 409 / VERSION_CONFLICT）。 */
export class VersionConflictError extends DbError {
  override readonly name = 'VersionConflictError';
  constructor(
    readonly model: string,
    readonly id: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(`${model} ${id} version conflict: expected ${expectedVersion}, current ${currentVersion}`);
  }
}

export class CursorInvalidError extends DbError {
  override readonly name = 'CursorInvalidError';
  constructor() {
    super('The pagination cursor is invalid');
  }
}

export class PaginationLimitError extends DbError {
  override readonly name = 'PaginationLimitError';
  constructor(readonly value: unknown) {
    super(`The limit parameter must be an integer between 1 and 100, got ${String(value)}`);
  }
}

export class SoftDeleteNotSupportedError extends DbError {
  override readonly name = 'SoftDeleteNotSupportedError';
  constructor(readonly model: string) {
    super(`${model} does not support soft delete`);
  }
}

/** DB 错误 → HTTP/CT-05 错误码映射（API 层使用；此处不引入 contracts 依赖）。 */
export function mapDbErrorToHttp(err: unknown): { status: number; code: string } {
  if (err instanceof VersionConflictError) return { status: 409, code: 'VERSION_CONFLICT' };
  if (err instanceof RecordNotFoundError) return { status: 404, code: 'NOT_FOUND' };
  if (err instanceof ScopeRequiredError) return { status: 403, code: 'FORBIDDEN' };
  if (err instanceof CursorInvalidError) return { status: 400, code: 'CURSOR_INVALID' };
  if (err instanceof PaginationLimitError) return { status: 400, code: 'VALIDATION_FAILED' };
  if (err instanceof SoftDeleteNotSupportedError) return { status: 400, code: 'VALIDATION_FAILED' };
  return { status: 500, code: 'INTERNAL_ERROR' };
}
