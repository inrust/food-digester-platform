import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { assert } from 'vitest';

const API_ID = 'https://fdp.test/contracts/rest/openapi.bundle.json';
const api = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../contracts/rest/openapi.bundle.json', import.meta.url)), 'utf8'),
) as Record<string, any>;
api.$id = API_ID;

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema(api);

const operations = new Map<string, { path: string; method: string }>();
for (const [path, pathItem] of Object.entries(api.paths as Record<string, Record<string, any>>)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (typeof operation?.operationId === 'string') operations.set(operation.operationId, { path, method });
  }
}

const pointerEscape = (value: string): string => value.replace(/~/gu, '~0').replace(/\//gu, '~1');

/** 直接校验完整 Handler body 或 Lambda JSON body，不允许调用方预先剥离 data/meta。 */
export function assertOpenApiResponse(operationId: string, status: number, body: unknown): void {
  const operation = operations.get(operationId);
  assert.ok(operation, `OpenAPI operation ${operationId} must exist`);
  const response = (api.paths as Record<string, any>)[operation.path]?.[operation.method]?.responses?.[status];
  assert.ok(response, `OpenAPI response must exist: ${operationId} ${status}`);
  const responsePointer =
    typeof response.$ref === 'string' && response.$ref.startsWith('#/')
      ? response.$ref
      : `#/paths/${pointerEscape(operation.path)}/${operation.method}/responses/${status}`;
  const pointer = `${responsePointer}/content/application~1json/schema`;
  const validate = ajv.getSchema(`${API_ID}${pointer}`);
  assert.ok(validate, `OpenAPI response schema must compile: ${operationId} ${status}`);
  let payload = body;
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body);
    } catch {
      assert.fail(`${operationId} ${status} Lambda body must be valid JSON`);
    }
  }
  assert.isTrue(validate(payload), ajv.errorsText(validate.errors, { separator: '\n' }));
}
