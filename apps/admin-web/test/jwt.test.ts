import { assert, test } from 'vitest';
import { decodeJwtPayload, jwtExpiresAtMs, SessionTokenError } from '../src/session/jwt.js';

function makeBrowserJwt(claims: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const payload = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  return `header.${payload}.signature`;
}

test('decodeJwtPayload 使用浏览器 API 解码 Base64URL 与 UTF-8', () => {
  const token = makeBrowserJwt({ username: '测试@example.com', exp: 1_800_000_000 });
  assert.deepEqual(decodeJwtPayload(token), { username: '测试@example.com', exp: 1_800_000_000 });
  assert.equal(jwtExpiresAtMs(token), 1_800_000_000_000);
});

test('decodeJwtPayload 对非法 Base64URL 失败关闭', () => {
  assert.throws(() => decodeJwtPayload('header.%%%.signature'), SessionTokenError);
});
