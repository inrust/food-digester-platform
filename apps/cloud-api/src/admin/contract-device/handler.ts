/**
 * BE-CON-02 Contract 与 Device 关联 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（contract:write=PlatformSuperAdmin；contract:read 另含
 * Operator/Auditor）→ Service。
 * 路由：
 * - GET  /api/v1/admin/contracts/{contractId}/devices            已关联设备（台账 DTO + 租期展示值）
 * - GET  /api/v1/admin/contracts/{contractId}/available-devices  可关联设备（同 Customer/非 Retired/无 ACTIVE 关联）
 * - GET  /api/v1/admin/contracts/{contractId}/associations       关联历史（ACTIVE/ENDED）
 * - POST /api/v1/admin/contracts/{contractId}/devices/bind       批量关联（全成或全败，强制原因）
 * - POST /api/v1/admin/contracts/{contractId}/devices/unbind     批量解绑（全成或全败，强制原因；不撤销 License）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { ContractStateError } from '@fdp/domain';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminContractError, contractValidationFailed } from '../contract/errors.js';
import {
  bindContractDevices,
  listAvailableDevices,
  listContractAssociations,
  listContractDevices,
  unbindContractDevices,
} from './service.js';
import type { ContractDeviceDeps } from './service.js';
import { parseStrictObject } from '../shared/strict-object.js';

export type AdminContractDeviceHandlerDeps = ContractDeviceDeps;

export interface AdminContractDeviceHandlers {
  listDevices(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listAvailable(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listAssociations(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  bind(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  unbind(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

const CONTRACT_STATE_ERROR_HTTP: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
};

function requireContractId(req: AdminHttpRequest): string {
  const contractId = req.params?.contractId;
  if (!contractId) throw contractValidationFailed('contractId path parameter is required');
  return contractId;
}

function requireDeviceIds(body: Record<string, unknown>): string[] {
  if (
    !Array.isArray(body.deviceIds) ||
    body.deviceIds.length === 0 ||
    body.deviceIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
  ) {
    throw contractValidationFailed('deviceIds must be a non-empty string array');
  }
  return (body.deviceIds as string[]).map((id) => id.trim());
}

function requireReason(body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw contractValidationFailed('The reason is required for this operation');
  return reason;
}

function optionalTimestamp(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw contractValidationFailed(`${field} must be an RFC 3339 UTC timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw contractValidationFailed(`${field} must be a valid RFC 3339 timestamp`);
  return date;
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

export function createAdminContractDeviceHandlers(deps: AdminContractDeviceHandlerDeps): AdminContractDeviceHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;

  const listDevices = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:read' },
    async (req) => {
      const items = await listContractDevices(deps, requireContractId(req));
      return { status: 200, body: { data: items, meta: meta(req) } };
    },
  );

  const listAvailable = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:read' },
    async (req) => {
      const items = await listAvailableDevices(deps, requireContractId(req));
      return { status: 200, body: { data: items, meta: meta(req) } };
    },
  );

  const listAssociations = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:read' },
    async (req) => {
      const items = await listContractAssociations(deps, requireContractId(req));
      return { status: 200, body: { data: items, meta: meta(req) } };
    },
  );

  const bind = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'contract:write' }, async (req) => {
    const body = parseStrictObject(req.body, ['deviceIds', 'validFrom', 'validTo', 'reason'], contractValidationFailed);
    const result = await bindContractDevices(deps, actorOf(req), requireContractId(req), {
      deviceIds: requireDeviceIds(body),
      validFrom: optionalTimestamp(body.validFrom, 'validFrom'),
      validTo: optionalTimestamp(body.validTo, 'validTo'),
      reason: requireReason(body),
    });
    return { status: 201, body: { data: result, meta: meta(req) } };
  });

  const unbind = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'contract:write' },
    async (req) => {
      const body = parseStrictObject(req.body, ['deviceIds', 'reason'], contractValidationFailed);
      const result = await unbindContractDevices(deps, actorOf(req), requireContractId(req), {
        deviceIds: requireDeviceIds(body),
        reason: requireReason(body),
      });
      return { status: 200, body: { data: result, meta: meta(req) } };
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
    listDevices: wrap(listDevices),
    listAvailable: wrap(listAvailable),
    listAssociations: wrap(listAssociations),
    bind: wrap(bind),
    unbind: wrap(unbind),
  };
}
