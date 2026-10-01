import { readFileSync, appendFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

export type Json = Record<string, any>;
const API_ID = 'https://fdp.test/qa02/openapi.json';
export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function createAjv(coerceTypes = false): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true, coerceTypes });
  ajv.addFormat('date', validDate);
  ajv.addFormat(
    'date-time',
    (value: string) =>
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?Z$/u.test(value) &&
      validDate(value.slice(0, 10)) &&
      Number.isFinite(Date.parse(value)),
  );
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  ajv.addFormat('uri', (value: string) => {
    try {
      return !!new URL(value).protocol;
    } catch {
      return false;
    }
  });
  ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/u);
  return ajv;
}
export interface ContractRequest {
  body?: unknown;
  params?: Readonly<Record<string, unknown>>;
  query?: Readonly<Record<string, unknown>>;
  headers?: Readonly<Record<string, unknown>>;
}
export interface ContractResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export class DeviceContract {
  readonly api: Json;
  readonly ajv: Ajv2020;
  readonly wireAjv: Ajv2020;
  readonly operations = new Map<string, { path: string; method: string; operation: Json; parameters: Json[] }>();
  readonly errors: Map<string, number>;
  readonly compiled = new Map<string, ValidateFunction>();
  constructor(api: Json, errorCodes: Json) {
    this.api = structuredClone(api);
    this.api.$id = API_ID;
    this.ajv = createAjv();
    this.ajv.addSchema(this.api);
    this.wireAjv = createAjv(true);
    this.wireAjv.addSchema(this.api);
    this.errors = new Map(errorCodes.errorCodes.map((item: Json) => [item.code, item.httpStatus]));
    for (const [path, pathItem] of Object.entries(this.api.paths) as [string, Json][]) {
      if (!path.startsWith('/api/v1/device/')) continue;
      for (const [method, operation] of Object.entries(pathItem) as [string, Json][]) {
        if (!operation?.operationId) continue;
        if (this.operations.has(operation.operationId)) throw new Error('DUPLICATE_OPERATION');
        this.operations.set(operation.operationId, {
          path,
          method,
          operation,
          parameters: [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((p) => this.resolve(p)),
        });
      }
    }
  }
  resolve(value: Json): Json {
    if (!value.$ref) return value;
    if (!value.$ref.startsWith('#/')) throw new Error('EXTERNAL_REF_NOT_BUNDLED');
    return value.$ref
      .slice(2)
      .split('/')
      .reduce((node: Json, key: string) => node[key.replace(/~1/gu, '/').replace(/~0/gu, '~')], this.api);
  }
  get(id: string) {
    const op = this.operations.get(id);
    if (!op) throw new Error(`UNKNOWN_OPERATION ${id}`);
    return op;
  }
  check(schema: Json, value: unknown, label: string, wire = false): void {
    const ajv = wire ? this.wireAjv : this.ajv;
    const key = `${wire}:` + JSON.stringify(schema);
    let validate = this.compiled.get(key);
    if (!validate) {
      validate = ajv.compile(schema);
      this.compiled.set(key, validate);
    }
    if (!validate(structuredClone(value))) throw new Error(`${label}: ${ajv.errorsText(validate.errors)}`);
  }
  assertRequest(id: string, request: ContractRequest): void {
    const { operation, parameters } = this.get(id);
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const parameter of parameters) {
      const field = parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name;
      const source = parameter.in === 'header' ? headers : parameter.in === 'path' ? request.params : request.query;
      const value = source?.[field];
      if (value === undefined) {
        if (parameter.required) throw new Error(`${id}: MISSING_${parameter.in}_${field}`);
        continue;
      }
      const schema = { ...parameter.schema };
      // Local schema refs resolve against the complete bundle, even for inline parameter schemas.
      this.check(absolutize(schema), value, `${id} ${parameter.in}.${field}`, true);
    }
    const body = operation.requestBody ? this.resolve(operation.requestBody) : undefined;
    if (request.body === undefined) {
      if (body?.required) throw new Error(`${id}: MISSING_BODY`);
      return;
    }
    if (!body) throw new Error(`${id}: BODY_FORBIDDEN`);
    this.check(absolutize(body.content['application/json'].schema), request.body, `${id} request`);
  }
  assertResponse(id: string, response: ContractResponse): void {
    const { operation } = this.get(id);
    const declared = operation.responses[String(response.status)];
    if (!declared) throw new Error(`${id}: UNDECLARED_STATUS ${response.status}`);
    const schema = this.resolve(declared);
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [name, definition] of Object.entries(schema.headers ?? {}) as [string, Json][]) {
      const header = this.resolve(definition);
      const value = headers[name.toLowerCase()];
      if (value === undefined) {
        if (header.required) throw new Error(`${id}: MISSING_RESPONSE_HEADER ${name}`);
        continue;
      }
      this.check(absolutize(header.schema), value, `${id} response header ${name}`);
    }
    if (!schema.content) {
      if (response.body !== undefined && response.body !== '') throw new Error(`${id}: UNDECLARED_RESPONSE_BODY`);
      return;
    }
    let payload = response.body;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw new Error(`${id}: INVALID_JSON_RESPONSE`);
      }
    }
    this.check(absolutize(schema.content['application/json'].schema), payload, `${id} ${response.status} response`);
    if (response.status >= 400) {
      const code = (payload as Json)?.error?.code;
      if (this.errors.get(code) !== response.status) throw new Error(`${id}: ERROR_CODE_STATUS_MISMATCH`);
    }
  }
}
function absolutize(schema: Json): Json {
  return JSON.parse(JSON.stringify(schema), (key, value) =>
    key === '$ref' && typeof value === 'string' && value.startsWith('#/') ? `${API_ID}${value}` : value,
  );
}
const json = (name: string) => JSON.parse(readFileSync(new URL(`../rest/${name}`, import.meta.url), 'utf8'));
export const deviceContract = new DeviceContract(json('openapi.bundle.json'), json('error-codes.json'));

/** Check unmodified real Handler input/output; preserve callbacks and never replace a business response. */
export function contractHandler<R extends ContractRequest, S extends ContractResponse>(
  id: string,
  handler: (request: R) => Promise<S>,
): (request: R) => Promise<S> {
  return async (request) => {
    let validRequest = true;
    try {
      deviceContract.assertRequest(id, request);
    } catch {
      validRequest = false;
    }
    const response = await handler(request);
    deviceContract.assertResponse(id, response);
    if (!validRequest && response.status < 400) throw new Error(`${id}: INVALID_REQUEST_ACCEPTED`);
    if (process.env.QA02_CONTRACT_TRACE)
      appendFileSync(
        process.env.QA02_CONTRACT_TRACE,
        JSON.stringify({ operationId: id, status: response.status, validRequest, source: 'REAL_HANDLER' }) + '\n',
      );
    return response;
  };
}
