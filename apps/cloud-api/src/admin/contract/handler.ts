/**
 * BE-CON-01 Contract CRUD 与状态 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入；contract:write =
 * PlatformSuperAdmin 仅超管（DEC-012 矩阵），contract:read 另含 Operator/Auditor）→ Service。
 * 路由：
 * - POST  /api/v1/admin/contracts                        创建（DRAFT；contractNumber 唯一）
 * - GET   /api/v1/admin/contracts                        列表（status 派生筛选/customerId）
 * - GET   /api/v1/admin/contracts/{contractId}           详情
 * - PATCH /api/v1/admin/contracts/{contractId}           编辑（If-Match + 强制原因）
 * - POST  /api/v1/admin/contracts/{contractId}/activate  激活（DRAFT→EFFECTIVE，If-Match + 原因）
 * - POST  /api/v1/admin/contracts/{contractId}/renew     续约（延长 endAt，If-Match + 原因）
 * - POST  /api/v1/admin/contracts/{contractId}/terminate 终止（If-Match + 强制原因）
 * - POST  /api/v1/admin/contracts/{contractId}/evaluate  时间派生复验（at 可注入，If-Match）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { ContractStateError } from '@fdp/domain';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminContractError, contractValidationFailed } from './errors.js';
import {
  activateContract,
  createContract,
  evaluateContract,
  getContract,
  listContracts,
  renewContract,
  terminateContract,
  updateContract,
} from './service.js';
import type { ContractDeps } from './service.js';
import { parseStrictObject } from '../shared/strict-object.js';
import { assertOptionalStringFields } from '../shared/strict-object.js';

export type AdminContractHandlerDeps = ContractDeps;

export interface AdminContractHandlers {
  create(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  update(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  activate(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  renew(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  terminate(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  evaluate(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

/** 领域 ContractStateError → CT-05 状态码。 */
const CONTRACT_STATE_ERROR_HTTP: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
};

function headerOf(req: AdminHttpRequest, name: string): string | undefined {
  return req.headers[name] ?? req.headers[name.toLowerCase()];
}

/** If-Match 解析（语义与 CT-05 parseIfMatch 一致）：缺失/非法 → 400 VALIDATION_FAILED。 */
function parseIfMatch(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw contractValidationFailed('The If-Match header is required for this operation');
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw contractValidationFailed('The If-Match header must be a positive integer version');
  }
  return version;
}

function requireContractId(req: AdminHttpRequest): string {
  const contractId = req.params?.contractId;
  if (!contractId) throw contractValidationFailed('contractId path parameter is required');
  return contractId;
}

function bodyOf(req: AdminHttpRequest, allowedKeys: readonly string[]): Record<string, unknown> {
  return parseStrictObject(req.body ?? {}, allowedKeys, contractValidationFailed);
}

function requireTimestamp(value: unknown, field: string): Date {
  if (typeof value !== 'string') throw contractValidationFailed(`${field} is required (RFC 3339 UTC timestamp)`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw contractValidationFailed(`${field} must be a valid RFC 3339 timestamp`);
  return date;
}

function optionalTimestamp(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  return requireTimestamp(value, field);
}

function optionalString(value: unknown, field: string, maxLength = 200): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw contractValidationFailed(`${field} must be a string of 1~${maxLength} characters`);
  }
  return value.trim();
}

/** 所有写操作强制原因。 */
function requireReason(body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw contractValidationFailed('The reason is required for this operation');
  return reason;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminContractError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  if (err instanceof ContractStateError) {
    const status = CONTRACT_STATE_ERROR_HTTP[err.code] ?? 500;
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

export function createAdminContractHandlers(deps: AdminContractHandlerDeps): AdminContractHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;
  /** 写操作公共入参：contractId + If-Match + 强制原因。 */
  const writeInputOf = (req: AdminHttpRequest, allowedKeys: readonly string[]) => ({
    contractId: requireContractId(req),
    ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
    reason: requireReason(bodyOf(req, allowedKeys)),
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:write' },
    async (req) => {
      const body = bodyOf(req, ['contractNumber', 'name', 'customerId', 'contact', 'startAt', 'endAt', 'reason']);
      assertOptionalStringFields(body, ['contact', 'reason'], contractValidationFailed);
      const contractNumber = optionalString(body.contractNumber, 'contractNumber', 100);
      const name = optionalString(body.name, 'name', 200);
      if (!contractNumber || !name) throw contractValidationFailed('contractNumber and name are required');
      if (typeof body.customerId !== 'string' || body.customerId.trim().length === 0) {
        throw contractValidationFailed('customerId is required');
      }
      const view = await createContract(deps, actorOf(req), {
        contractNumber,
        name,
        customerId: body.customerId.trim(),
        ...(typeof body.contact === 'string' ? { contact: body.contact } : {}),
        startAt: requireTimestamp(body.startAt, 'startAt'),
        endAt: requireTimestamp(body.endAt, 'endAt'),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      return { status: 201, body: { data: view, meta: meta(req) } };
    },
  );

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'contract:read' }, async (req) => {
    const items = await listContracts(deps, actorOf(req), {
      ...(req.query?.status !== undefined ? { status: req.query.status } : {}),
      ...(req.query?.customerId !== undefined ? { customerId: req.query.customerId } : {}),
    });
    return { status: 200, body: { data: items, meta: meta(req) } };
  });

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:read' },
    async (req) => {
      const view = await getContract(deps, actorOf(req), requireContractId(req));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const update = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:write' },
    async (req) => {
      const body = bodyOf(req, ['name', 'contact', 'startAt', 'endAt', 'reason']);
      if (body.contact !== undefined && body.contact !== null && typeof body.contact !== 'string') {
        throw contractValidationFailed('contact must be a string or null');
      }
      const view = await updateContract(deps, actorOf(req), {
        ...writeInputOf(req, ['name', 'contact', 'startAt', 'endAt', 'reason']),
        ...(body.name !== undefined ? { name: optionalString(body.name, 'name', 200) } : {}),
        ...(body.contact !== undefined ? { contact: body.contact as string | null } : {}),
        ...(body.startAt !== undefined ? { startAt: requireTimestamp(body.startAt, 'startAt') } : {}),
        ...(body.endAt !== undefined ? { endAt: requireTimestamp(body.endAt, 'endAt') } : {}),
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const activate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:write' },
    async (req) => {
      const view = await activateContract(deps, actorOf(req), writeInputOf(req, ['reason']));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const renew = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:write' },
    async (req) => {
      const body = bodyOf(req, ['newEndAt', 'reason']);
      const view = await renewContract(deps, actorOf(req), {
        ...writeInputOf(req, ['newEndAt', 'reason']),
        newEndAt: requireTimestamp(body.newEndAt, 'newEndAt'),
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const terminate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:write' },
    async (req) => {
      const view = await terminateContract(deps, actorOf(req), writeInputOf(req, ['reason']));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const evaluate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:write' },
    async (req) => {
      const body = bodyOf(req, ['at']);
      const at = optionalTimestamp(body.at, 'at') ?? now();
      const result = await evaluateContract(
        deps,
        actorOf(req),
        requireContractId(req),
        parseIfMatch(headerOf(req, 'If-Match')),
        at,
      );
      return { status: 200, body: { data: { ...result.view, changed: result.changed }, meta: meta(req) } };
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
    create: wrap(create),
    list: wrap(list),
    detail: wrap(detail),
    update: wrap(update),
    activate: wrap(activate),
    renew: wrap(renew),
    terminate: wrap(terminate),
    evaluate: wrap(evaluate),
  };
}
