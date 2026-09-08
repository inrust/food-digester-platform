/** OpenAPI additionalProperties=false 的运行时对应实现。 */
export function parseStrictObject(
  body: unknown,
  allowedKeys: readonly string[],
  validationError: (message: string) => Error,
): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('request body must be an object');
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw validationError(`unknown field: ${unknown}`);
  return input;
}

/** OpenAPI 未声明 requestBody 时拒绝携带任何实体。 */
export function rejectRequestBody(body: unknown, validationError: (message: string) => Error): void {
  if (body !== undefined && body !== null) throw validationError('request body is not allowed');
}

/** 对 OpenAPI string 可选字段执行类型检查，避免 Handler 静默忽略错误类型。 */
export function assertOptionalStringFields(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  validationError: (message: string) => Error,
): void {
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== 'string') {
      throw validationError(`${field} must be a string`);
    }
  }
}
