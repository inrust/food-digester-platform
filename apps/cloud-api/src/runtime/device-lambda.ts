/** Device API Gateway 的可信生产适配器：mTLS 身份只从 requestContext 注入。 */
import type { ClientCertIdentity } from '@fdp/auth';

export interface ApiGatewayDeviceEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly httpMethod?: string;
  readonly path?: string;
  readonly rawPath?: string;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly identity?: {
      readonly sourceIp?: string;
      readonly clientCert?: ClientCertIdentity;
    };
    readonly http?: { readonly sourceIp?: string; readonly method?: string; readonly path?: string };
    readonly authentication?: { readonly clientCert?: ClientCertIdentity };
  };
  /** 防止调用者把伪造身份混进事件后被宽松 spread。 */
  readonly identity?: unknown;
}

export interface ApiGatewayDeviceResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DeviceRuntimeRequest {
  readonly identity?: ClientCertIdentity;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly requestId: string;
}

export interface DeviceRuntimeResponse {
  readonly status: number;
  readonly body: unknown;
  readonly onCommitted?: (() => Promise<void>) | undefined;
}

export type DeviceRoute = (request: DeviceRuntimeRequest) => Promise<DeviceRuntimeResponse>;

export interface DeviceRouteSet {
  readonly certificateStatus: DeviceRoute;
  readonly certificateRotate: DeviceRoute;
  readonly sync: DeviceRoute;
  readonly deactivate: DeviceRoute;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function result(statusCode: number, body: unknown): ApiGatewayDeviceResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * Rotate 的 onCommitted 在响应成功序列化后、交还 API Gateway 前执行。
 * 序列化或提交失败均返回通用 500，绝不把一次性私钥作为 200 响应交付。
 */
export function createDeviceApiLambdaHandler(routes: DeviceRouteSet) {
  return async (event: ApiGatewayDeviceEvent): Promise<ApiGatewayDeviceResult> => {
    const method = (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase();
    const path = event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? '';
    const requestId = event.requestContext?.requestId ?? 'unknown';

    let body: unknown;
    try {
      const encoded = event.body;
      const raw = encoded && event.isBase64Encoded ? Buffer.from(encoded, 'base64').toString('utf8') : encoded;
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return result(400, {
        error: { code: 'VALIDATION_FAILED', message: 'Request body must be valid JSON', requestId },
      });
    }

    const clientCert = event.requestContext?.identity?.clientCert ?? event.requestContext?.authentication?.clientCert;
    const request: DeviceRuntimeRequest = {
      requestId,
      ...(body !== undefined ? { body } : {}),
      ...(event.queryStringParameters ? { query: event.queryStringParameters } : {}),
      ...(clientCert ? { identity: clientCert } : {}),
    };

    let route: DeviceRoute | undefined;
    if (method === 'GET' && /^\/api\/v1\/device\/certificate\/status\/?$/.test(path)) {
      route = routes.certificateStatus;
    } else if (method === 'POST' && /^\/api\/v1\/device\/certificate\/rotate\/?$/.test(path)) {
      route = routes.certificateRotate;
    } else if (method === 'POST' && /^\/api\/v1\/device\/sync\/?$/.test(path)) {
      route = routes.sync;
    } else if (method === 'POST' && /^\/api\/v1\/device\/deactivate\/?$/.test(path)) {
      route = routes.deactivate;
    }
    if (!route) {
      return result(404, {
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found', requestId },
      });
    }

    try {
      const response = await route(request);
      const serialized = JSON.stringify(response.body);
      await response.onCommitted?.();
      return { statusCode: response.status, headers: JSON_HEADERS, body: serialized };
    } catch {
      return result(500, {
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
      });
    }
  };
}
