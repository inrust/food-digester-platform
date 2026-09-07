import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { assert } from 'vitest';

const API_ID = 'https://fdp.test/contracts/rest/device-onboarding-api.json';
const api = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../contracts/rest/device-onboarding-api.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;
api.$id = API_ID;

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema(api);

/** 用真实 OpenAPI 组件校验 Handler 实际响应，防止实现测试把错误线协议固化成绿灯。 */
export function assertOnboardingOpenApiResponse(
  schemaName: 'OnboardingRequestResult' | 'OnboardingStatusResult',
  payload: unknown,
): void {
  const validate = ajv.getSchema(`${API_ID}#/components/schemas/${schemaName}`);
  assert.ok(validate, `OpenAPI schema ${schemaName} must compile`);
  assert.isTrue(validate(payload), ajv.errorsText(validate.errors, { separator: '\n' }));
}
