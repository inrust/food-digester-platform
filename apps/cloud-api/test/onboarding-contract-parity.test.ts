/**
 * BE-ONB-01 与 CT-05 契约一致性 + 无 AWS 副作用证据。
 *
 * - OnboardingApiError 的错误码/HTTP 状态与 contracts/rest/error-codes.json 一致；
 * - DTO 校验字段集合与 contracts/rest/device-onboarding-api.json 请求体一致；
 * - onboarding 模块源码不引用任何 AWS 客户端（验收基准：无 AWS 资源副作用）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, test } from 'vitest';
import { ONBOARDING_API_ERROR_HTTP_STATUS, parseOnboardingRequestBody } from '../src/index.js';

const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);

function loadJson(name: string) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));
}

test('OnboardingApiError 错误码与 CT-05 错误码目录一致', () => {
  const catalog = new Map<string, number>(
    (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
      e.code,
      e.httpStatus,
    ]),
  );
  for (const [code, status] of Object.entries(ONBOARDING_API_ERROR_HTTP_STATUS)) {
    assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
  }
});

test('DTO 校验字段与 OpenAPI 请求体契约一致', () => {
  const api = loadJson('device-onboarding-api.json');
  const required = api.components.schemas.OnboardingRequestInput.required as string[];
  // 每个契约必填字段缺失时均为 VALIDATION_FAILED
  const full: Record<string, unknown> = {
    serialNumber: 'SN-PARITY',
    model: 'BNX-100',
    hardwareVersion: 'HW1.0',
    manufacturer: 'Hiddenjoy',
    manufactureDate: '2026-01-01',
  };
  for (const field of required) {
    const body = { ...full, [field]: undefined };
    let code: string | undefined;
    try {
      parseOnboardingRequestBody(body, new Date('2026-08-27T00:00:00Z'));
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    assert.equal(code, 'VALIDATION_FAILED', `缺少 ${field} 应校验失败`);
  }
  // 完整字段可通过校验
  const parsed = parseOnboardingRequestBody(full, new Date('2026-08-27T00:00:00Z'));
  assert.deepEqual(Object.keys(parsed).sort(), [...required].sort());
});

test('onboarding 模块无任何 AWS 依赖（无 AWS 资源副作用）', () => {
  const dir = fileURLToPath(new URL('../src/onboarding/', import.meta.url));
  for (const file of readdirSync(dir)) {
    const source = readFileSync(`${dir}/${file}`, 'utf8');
    assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
  }
});
