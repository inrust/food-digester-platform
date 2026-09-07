/** Onboarding Token API Gateway 的可信生产适配器；不经过 Cognito 管理认证。 */
import type { OnboardingHttpRequest, OnboardingHttpResponse, OnboardingStatusRequest } from '../onboarding/index.js';
import { matchDeliveredOperation } from './delivered-operations.js';

export interface ApiGatewayOnboardingEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly httpMethod?: string;
  readonly path?: string;
  readonly rawPath?: string;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly identity?: { readonly sourceIp?: string };
    readonly http?: { readonly sourceIp?: string; readonly method?: string; readonly path?: string };
  };
}

export interface ApiGatewayOnboardingResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DeviceOnboardingRoutes {
  readonly request: (request: OnboardingHttpRequest) => Promise<OnboardingHttpResponse>;
  readonly status: (request: OnboardingStatusRequest) => Promise<OnboardingHttpResponse>;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function result(statusCode: number, body: unknown): ApiGatewayOnboardingResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * 交付确认点定义：业务响应完成 JSON 序列化后、交还 API Gateway 前执行 onCommitted。
 * 回调失败时不返回含密钥的成功响应，而返回通用 500；下一次轮询按未确认交付恢复。
 */
export function createDeviceOnboardingLambdaHandler(routes: DeviceOnboardingRoutes) {
  return async (event: ApiGatewayOnboardingEvent): Promise<ApiGatewayOnboardingResult> => {
    const method = (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase();
    const path = event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? '';
    const requestId = event.requestContext?.requestId ?? 'unknown';
    const headers = event.headers ?? {};

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

    const sourceIp = event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp;
    const request: OnboardingStatusRequest = {
      headers,
      requestId,
      ...(body !== undefined ? { body } : {}),
      ...(event.queryStringParameters ? { query: event.queryStringParameters } : {}),
      ...(sourceIp !== undefined ? { sourceIp } : {}),
    };

    const matched = matchDeliveredOperation('onboarding-api', method, path);
    let response: OnboardingHttpResponse;
    if (matched?.operation.operationId === 'submitOnboardingRequest') {
      response = await routes.request(request);
    } else if (matched?.operation.operationId === 'getOnboardingStatus') {
      response = await routes.status(request);
    } else {
      return result(404, {
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found', requestId },
      });
    }

    try {
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
