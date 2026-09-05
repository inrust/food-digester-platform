/**
 * BE-ONB-02 管理端 Handler（框架无关）：待审批列表、详情、approve、reject。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入）→ Service。
 * - 列表/详情：onboarding:read（PlatformSuperAdmin/PlatformOperator/Auditor）；
 * - approve/reject：onboarding:approve（仅 PlatformSuperAdmin，权限矩阵唯一持有者）；
 * - 写操作强制 If-Match（缺失/非法 → 400；版本不符 → 409 VERSION_CONFLICT）；
 * - 响应契约对齐 CT-05：data + meta{requestId,timestamp[,nextCursor]}；
 *   错误 {error{code,message,requestId}}，未知异常一律 500 通用消息。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import { AdminOnboardingError, validationFailed } from './errors.js';
import { findOnboardingRequestById, listOnboardingRequests, toDto } from './repository.js';
import type { AdminOnboardingRequestDto } from './repository.js';
import { reviewOnboardingRequest } from './service.js';
import type { ProvisioningTrigger } from './service.js';

export interface AdminHttpRequest {
  /** Cognito 认证后的调用者（适配层注入）；缺失 → 401。 */
  readonly actor?: ActorContext | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly requestId: string;
  /** 可信 HTTP/Lambda 适配层解析后的传输元数据，不得取自业务 body。 */
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

export interface AdminHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface AdminOnboardingHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly provisioningTrigger?: ProvisioningTrigger;
}

export interface AdminOnboardingHandlers {
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  approve(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  reject(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function headerOf(req: AdminHttpRequest, name: string): string | undefined {
  return req.headers[name] ?? req.headers[name.toLowerCase()];
}

/** If-Match 解析（语义与 CT-05 parseIfMatch 一致）：缺失/非法 → 400 VALIDATION_FAILED。 */
function parseIfMatch(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw validationFailed('The If-Match header is required for this operation');
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw validationFailed('The If-Match header must be a non-negative integer version');
  }
  return version;
}

function requireRequestId(req: AdminHttpRequest): string {
  const requestId = req.params?.requestId;
  if (!requestId) throw validationFailed('requestId path parameter is required');
  return requestId;
}

function meta(req: AdminHttpRequest, now: Date) {
  return { requestId: req.requestId, timestamp: now.toISOString() };
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  if (err instanceof AdminOnboardingError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  const mapped = mapDbErrorToHttp(err);
  if (mapped.status !== 500) {
    return {
      status: mapped.status,
      body: { error: { code: mapped.code, message: 'The request failed validation', requestId: req.requestId } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

export function createAdminOnboardingHandlers(deps: AdminOnboardingHandlerDeps): AdminOnboardingHandlers {
  const now = deps.now ?? (() => new Date());

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'onboarding:read' },
    async (req) => {
      const page = await listOnboardingRequests(deps.client, {
        status: req.query?.status,
        cursor: req.query?.cursor,
        limit: req.query?.limit,
      });
      return {
        status: 200,
        body: { data: page.items.map(toDto), meta: { ...meta(req, now()), nextCursor: page.nextCursor } },
      };
    },
  );

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'onboarding:read' },
    async (req) => {
      const record = await findOnboardingRequestById(deps.client, requireRequestId(req));
      if (!record) throw new AdminOnboardingError('NOT_FOUND', 'The requested resource was not found');
      return { status: 200, body: { data: toDto(record), meta: meta(req, now()) } };
    },
  );

  const review = (decision: 'approve' | 'reject') =>
    withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'onboarding:approve' }, async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const record = await reviewOnboardingRequest(
        deps.client,
        req.actor,
        {
          requestId: requireRequestId(req),
          decision,
          ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
          ...(reason !== undefined ? { reason } : {}),
        },
        {
          now: deps.now ?? (() => new Date()),
          ...(deps.provisioningTrigger ? { provisioningTrigger: deps.provisioningTrigger } : {}),
        },
      );
      const dto: AdminOnboardingRequestDto = toDto(record);
      return { status: 200, body: { data: dto, meta: meta(req, now()) } };
    });

  const wrap =
    (fn: (req: AdminHttpRequest) => Promise<AdminHttpResponse>) =>
    async (req: AdminHttpRequest): Promise<AdminHttpResponse> => {
      try {
        return await fn(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    };

  return { list: wrap(list), detail: wrap(detail), approve: wrap(review('approve')), reject: wrap(review('reject')) };
}
