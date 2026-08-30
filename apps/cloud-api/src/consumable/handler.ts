/**
 * BE-CNS-01 耗材状态查询 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（device:read）→ Service。
 * 路由：GET /api/v1/admin/consumables —— 耗材状态列表（Region/Subregion/Site、连接状态、
 * 关键字、耗材阈值筛选；两种耗材列恒在，未上报为 null 且 remainingDisplay='unknown'；
 * 联系人授权摘要仅授权角色可见；Customer 角色租户隔离）。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../admin/onboarding/handler.js';
import { AdminConsumableError, consumableValidationFailed } from './errors.js';
import { listConsumableStatus } from './service.js';
import type { ConsumableDeps } from './service.js';

export type AdminConsumableHandlerDeps = ConsumableDeps;

export interface AdminConsumableHandlers {
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminConsumableError) {
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

function optionalPercent(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw consumableValidationFailed(`${field} must be an integer between 0 and 100`);
  return n;
}

export function createAdminConsumableHandlers(deps: AdminConsumableHandlerDeps): AdminConsumableHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const q = req.query ?? {};
    const items = await listConsumableStatus(deps, req.actor as ActorContext, {
      ...(q.region !== undefined ? { region: q.region } : {}),
      ...(q.subregion !== undefined ? { subregion: q.subregion } : {}),
      ...(q.siteId !== undefined ? { siteId: q.siteId } : {}),
      ...(q.connectivity !== undefined ? { connectivity: q.connectivity } : {}),
      ...(q.keyword !== undefined ? { keyword: q.keyword } : {}),
      ...(q.maxRemainingPercent !== undefined
        ? { maxRemainingPercent: optionalPercent(q.maxRemainingPercent, 'maxRemainingPercent') }
        : {}),
      ...(q.consumableType !== undefined ? { consumableType: q.consumableType } : {}),
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
    });
    return { status: 200, body: { data: items, meta: meta(req) } };
  });

  return {
    list: async (req) => {
      try {
        return await list(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    },
  };
}
