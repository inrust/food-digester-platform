/**
 * AUTH-01 与 CT-05 契约一致性：AuthError 使用的错误码与 HTTP 状态必须
 * 与 contracts/rest/error-codes.json 目录保持一致（401 UNAUTHENTICATED / 403 FORBIDDEN）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, test } from 'vitest';
import { AUTH_ERROR_HTTP_STATUS } from '../src/index.js';
import type { AuthErrorCode } from '../src/index.js';

interface ErrorCodeEntry {
  readonly code: string;
  readonly httpStatus: number;
}

function loadCatalog(): ErrorCodeEntry[] {
  const path = fileURLToPath(new URL('../../../contracts/rest/error-codes.json', import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { errorCodes: ErrorCodeEntry[] }).errorCodes;
}

test('AuthError 错误码与 CT-05 错误码目录一致', () => {
  const catalog = new Map(loadCatalog().map((entry) => [entry.code, entry.httpStatus]));
  for (const [code, status] of Object.entries(AUTH_ERROR_HTTP_STATUS) as [AuthErrorCode, number][]) {
    assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
  }
});
