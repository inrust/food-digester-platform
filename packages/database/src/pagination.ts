/**
 * DB-02 键集游标分页。
 * 不透明游标（base64url JSON，键 = 上一页末条 id）；
 * 与 CT-05 的分页语义一致：limit 默认 50、范围 1~100，非法游标为确定性错误。
 */
import { CursorInvalidError, PaginationLimitError } from './errors.js';

interface KeysetCursor {
  readonly v: 1;
  /** 上一页末条记录 id。 */
  readonly k: string;
}

export interface PageArgs {
  readonly cursor?: string | null;
  readonly limit?: number | string | null;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export function encodeKeysetCursor(lastId: string): string {
  const payload: KeysetCursor = { v: 1, k: lastId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** 解析游标；空值视为首页，非法输入抛 CursorInvalidError。 */
export function decodeKeysetCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<KeysetCursor>;
    if (parsed.v !== 1 || typeof parsed.k !== 'string' || parsed.k.length === 0) {
      throw new Error('bad cursor payload');
    }
    return parsed.k;
  } catch {
    throw new CursorInvalidError();
  }
}

/** limit 归一化：默认 50，范围 1~100。 */
export function normalizeLimit(value: number | string | null | undefined): number {
  if (value === undefined || value === null || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PaginationLimitError(value);
  return limit;
}
