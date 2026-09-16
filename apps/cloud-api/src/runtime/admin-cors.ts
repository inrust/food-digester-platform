import type { ApiGatewayAdminEvent, ApiGatewayAdminResult } from './admin-lambda.js';

export const ADMIN_CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const ADMIN_CORS_HEADERS = [
  'authorization',
  'content-type',
  'if-match',
  'idempotency-key',
  'x-request-id',
] as const;

export function validateAdminOrigin(origin: string): string {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  ) {
    throw new Error('adminWebOrigin 必须为精确 HTTPS Origin（本地回环允许 HTTP）');
  }
  return origin;
}

/** Preflight precedes cold-start Secrets/DB/auth initialization; CORS is not authorization. */
export async function withAdminCors(
  event: ApiGatewayAdminEvent,
  origin: string | undefined,
  next: () => Promise<ApiGatewayAdminResult>,
): Promise<ApiGatewayAdminResult> {
  if (origin) validateAdminOrigin(origin);
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const path = event.path ?? event.rawPath ?? '';
  const scoped = /^\/api\/v1\/(admin|customer)(\/|$)/u.test(path);
  const allowed = scoped && !!origin && headers.origin === origin;
  const cors: Record<string, string> = allowed
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Expose-Headers': 'ETag,X-Request-Id',
      }
    : {};
  const method = event.httpMethod ?? event.requestContext?.http?.method;
  if (method === 'OPTIONS') {
    const requestedMethod = headers['access-control-request-method'];
    const requestedHeaders = (headers['access-control-request-headers'] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const valid =
      allowed &&
      ADMIN_CORS_METHODS.some((value) => value === requestedMethod) &&
      requestedHeaders.every((value) => ADMIN_CORS_HEADERS.some((header) => header === value));
    return {
      statusCode: valid ? 204 : 403,
      headers: {
        Vary: 'Origin,Access-Control-Request-Method,Access-Control-Request-Headers',
        ...(valid
          ? {
              ...cors,
              'Access-Control-Allow-Methods': ADMIN_CORS_METHODS.join(','),
              'Access-Control-Allow-Headers': ADMIN_CORS_HEADERS.join(','),
              'Access-Control-Max-Age': '300',
            }
          : {}),
      },
      body: '',
    };
  }
  let response: ApiGatewayAdminResult;
  try {
    response = await next();
  } catch {
    response = {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }),
    };
  }
  return {
    ...response,
    headers: { ...response.headers, ...cors, Vary: [response.headers.Vary, 'Origin'].filter(Boolean).join(',') },
  };
}
