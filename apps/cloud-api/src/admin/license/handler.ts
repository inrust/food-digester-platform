/**
 * BE-LIC-01 License/Entitlement API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入；license:write =
 * PlatformSuperAdmin/PlatformOperator，license:read 另含 Auditor）→ Service。
 * 路由：
 * - GET  /api/v1/admin/licenses                       正式实体列表（含终态历史）
 * - POST /api/v1/admin/licenses                     创建 Draft（配置 Entitlement）
 * - POST /api/v1/admin/licenses/{licenseId}/issue     Draft→Issued（生成签名）
 * - POST /api/v1/admin/licenses/{licenseId}/activate  Issued→Active（SYSTEM 激活，要求已到 validFrom）
 * - POST /api/v1/admin/licenses/{licenseId}/renew     ExpiringSoon→Renewed（延长 validTo + 重签；幂等回放）
 * - POST /api/v1/admin/licenses/{licenseId}/revoke    Active/Expired→Revoked（强制原因）
 * - POST /api/v1/admin/licenses/{licenseId}/evaluate  可测试时间派生（at 可注入；SYSTEM）
 * - GET  /api/v1/admin/licenses/{licenseId}           详情（含 signature 供 Sync）
 * - GET  /api/v1/admin/licenses/{licenseId}/history   状态历史
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { LicenseStateError } from '@fdp/domain';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminLicenseError, licenseValidationFailed } from './errors.js';
import {
  activateLicense,
  createDraftLicense,
  evaluateLicense,
  getLicense,
  issueLicense,
  listLicenses,
  listLicenseHistory,
  renewLicenseById,
  revokeLicense,
  entitlementFromWire,
} from './service.js';
import type { LicenseDeps } from './service.js';
import { assertOptionalStringFields, parseStrictObject, rejectRequestBody } from '../shared/strict-object.js';

export type AdminLicenseHandlerDeps = LicenseDeps;

export interface AdminLicenseHandlers {
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  create(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  issue(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  activate(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  renew(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  revoke(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  evaluate(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  history(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

/** DOM-02 LicenseStateError → CT-05 状态码（message 统一对外安全文案）。 */
const LICENSE_STATE_ERROR_HTTP: Readonly<Record<string, number>> = {
  DEVICE_STATE_NOT_ALLOWED: 409,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
};

function requireLicenseId(req: AdminHttpRequest): string {
  const licenseId = req.params?.licenseId;
  if (!licenseId) throw licenseValidationFailed('licenseId path parameter is required');
  return licenseId;
}

function requireTimestamp(value: unknown, field: string): Date {
  if (typeof value !== 'string') throw licenseValidationFailed(`${field} is required (RFC 3339 UTC timestamp)`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw licenseValidationFailed(`${field} must be a valid RFC 3339 timestamp`);
  return date;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminLicenseError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  if (err instanceof LicenseStateError) {
    const status = LICENSE_STATE_ERROR_HTTP[err.code] ?? 500;
    return {
      status,
      body: { error: { code: err.code, message: 'The request failed validation', requestId: req.requestId } },
    };
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

export function createAdminLicenseHandlers(deps: AdminLicenseHandlerDeps): AdminLicenseHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'license:write' },
    async (req) => {
      const body = parseStrictObject(
        req.body,
        ['deviceId', 'validFrom', 'validTo', 'entitlements', 'reason'],
        licenseValidationFailed,
      );
      const deviceId =
        typeof body.deviceId === 'string' && body.deviceId.trim().length > 0 ? body.deviceId.trim() : null;
      if (!deviceId) throw licenseValidationFailed('deviceId is required');
      if (!Array.isArray(body.entitlements) || body.entitlements.some((e) => typeof e !== 'string')) {
        throw licenseValidationFailed('entitlements must be a string array');
      }
      assertOptionalStringFields(body, ['reason'], licenseValidationFailed);
      const wireEntitlements = body.entitlements as string[];
      if (
        wireEntitlements.some((code) => !['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING'].includes(code)) ||
        new Set(wireEntitlements).size !== wireEntitlements.length
      ) {
        throw licenseValidationFailed('entitlements contains an unknown or duplicate wire code');
      }
      const view = await createDraftLicense(deps, actorOf(req), {
        deviceId,
        validFrom: requireTimestamp(body.validFrom, 'validFrom'),
        validTo: requireTimestamp(body.validTo, 'validTo'),
        entitlements: wireEntitlements.map(entitlementFromWire),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      return { status: 201, body: { data: view, meta: meta(req) } };
    },
  );

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'license:read' }, async (req) => {
    const q = req.query ?? {};
    const page = await listLicenses(deps, actorOf(req), {
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.keyword !== undefined ? { keyword: q.keyword } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
  });

  const issue = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'license:write' }, async (req) => {
    rejectRequestBody(req.body, licenseValidationFailed);
    const view = await issueLicense(deps, actorOf(req), { licenseId: requireLicenseId(req) });
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const activate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'license:write' },
    async (req) => {
      rejectRequestBody(req.body, licenseValidationFailed);
      const view = await activateLicense(deps, actorOf(req), { licenseId: requireLicenseId(req) });
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const renew = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'license:write' }, async (req) => {
    const body = parseStrictObject(req.body, ['newValidTo'], licenseValidationFailed);
    const view = await renewLicenseById(deps, actorOf(req), {
      licenseId: requireLicenseId(req),
      newValidTo: requireTimestamp(body.newValidTo, 'newValidTo'),
    });
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const revoke = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'license:write' },
    async (req) => {
      const body = parseStrictObject(req.body, ['reason'], licenseValidationFailed);
      const view = await revokeLicense(deps, actorOf(req), {
        licenseId: requireLicenseId(req),
        ...(typeof body.reason === 'string' ? { auditReason: body.reason } : {}),
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const evaluate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'license:write' },
    async (req) => {
      const body = parseStrictObject(req.body ?? {}, ['at'], licenseValidationFailed);
      const at = body.at === undefined ? now() : requireTimestamp(body.at, 'at');
      const result = await evaluateLicense(deps, actorOf(req), requireLicenseId(req), at);
      return { status: 200, body: { data: { ...result.view, changed: result.changed }, meta: meta(req) } };
    },
  );

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'license:read' }, async (req) => {
    const view = await getLicense(deps, requireLicenseId(req));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const history = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'license:read' },
    async (req) => {
      const items = await listLicenseHistory(deps, requireLicenseId(req));
      return { status: 200, body: { data: items, meta: meta(req) } };
    },
  );

  const wrap =
    (fn: (req: AdminHttpRequest) => Promise<AdminHttpResponse>) =>
    async (req: AdminHttpRequest): Promise<AdminHttpResponse> => {
      try {
        return await fn(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    };

  return {
    list: wrap(list),
    create: wrap(create),
    issue: wrap(issue),
    activate: wrap(activate),
    renew: wrap(renew),
    revoke: wrap(revoke),
    evaluate: wrap(evaluate),
    detail: wrap(detail),
    history: wrap(history),
  };
}
