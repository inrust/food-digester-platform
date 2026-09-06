/**
 * FE-01 测试工具：伪造未签名 JWT 与脚本化传输层。
 */
import { assert } from 'vitest';
import type { IdpFetch, IdpHttpResponse } from '../src/auth/cognito-idp.js';
import type { ApiFetch, ApiFetchResponse } from '../src/api/http-client.js';

/** 断言异步调用抛出异常并满足检查（仓库测试风格：chai assert + try/catch）。 */
export async function expectRejects(promise: Promise<unknown>, check: (err: unknown) => void): Promise<void> {
  try {
    await promise;
  } catch (err) {
    check(err);
    return;
  }
  assert.fail('应抛出异常，但实际成功返回');
}

/** 断言同步调用抛出异常并满足检查。 */
export function expectThrows(fn: () => unknown, check: (err: unknown) => void): void {
  try {
    fn();
  } catch (err) {
    check(err);
    return;
  }
  assert.fail('应抛出异常，但实际成功返回');
}

/** 构造未验签 JWT（仅测试用；前端本就不验签，验签在 AUTH-01 后端）。 */
export function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.test-signature`;
}

export function makeIdToken(options: {
  groups: string[];
  username?: string;
  customerId?: string | undefined;
  expSeconds?: number;
}): string {
  return makeJwt({
    sub: 'user-sub-1',
    'cognito:username': options.username ?? 'zhang@example.com',
    'cognito:groups': options.groups,
    ...(options.customerId !== undefined ? { 'custom:customer_id': options.customerId } : {}),
    token_use: 'id',
    exp: options.expSeconds ?? Math.floor(Date.now() / 1000) + 3600,
  });
}

export function makeAccessToken(expiresAtMs: number): string {
  return makeJwt({ sub: 'user-sub-1', token_use: 'access', exp: Math.floor(expiresAtMs / 1000) });
}

export interface RecordedIdpCall {
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}

/** 脚本化 Cognito 传输：按序返回响应；记录全部调用。 */
export function scriptedIdpFetch(script: IdpHttpResponse[]): {
  fetch: IdpFetch;
  calls: RecordedIdpCall[];
} {
  const calls: RecordedIdpCall[] = [];
  let index = 0;
  return {
    calls,
    fetch: async (operation, payload) => {
      calls.push({ operation, payload });
      const next = script[index];
      index += 1;
      if (next === undefined) throw new Error(`unexpected IDP call: ${operation}`);
      return next;
    },
  };
}

export interface RecordedApiCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** 脚本化 API 传输：按序返回响应；记录全部调用。 */
export function scriptedApiFetch(script: ApiFetchResponse[]): {
  fetch: ApiFetch;
  calls: RecordedApiCall[];
} {
  const calls: RecordedApiCall[] = [];
  let index = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const next = script[index];
      index += 1;
      if (next === undefined) throw new Error(`unexpected API call: ${url}`);
      return next;
    },
  };
}
