/**
 * BE-DEV-01 Device 台账查询 API Handler（框架无关，只读）。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入）→ Repository。
 * 路由：
 * - GET /api/v1/admin/devices              列表（device:read；Customer/Region/Subregion/Site/
 *                                          生命周期/Operational/连接/授权/型号/关键字筛选 +
 *                                          键集游标分页；Customer 角色强制所属 Customer scope）
 * - GET /api/v1/admin/devices/{deviceId}   详情（device:read；Customer 角色仅本 Customer 设备）
 * - PATCH /api/v1/admin/devices/{deviceId}/metadata  可编辑元数据（BE-DEV-06：device:write；
 *                                          V1 白名单仅 alias；If-Match 乐观锁；业务审计）
 * 查询接口不修改任何状态；连接状态由 lastHeartbeatAt 与阈值派生，不写回生命周期字段；
 * 不返回私钥或完整证书（仅 certificateId + fingerprint 摘要）。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp[,nextCursor]}。
 */
import { AuthError, assertCustomerScope, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminDeviceError, deviceNotFound, deviceValidationFailed } from './errors.js';
import { DEFAULT_CONNECTIVITY_THRESHOLD_MS, findDeviceById, listDevices, toDeviceDto } from './repository.js';
import { updateDeviceMetadata } from './metadata-service.js';

export interface AdminDeviceHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  /** 连接状态派生阈值（默认 10 分钟，见 DEFAULT_CONNECTIVITY_THRESHOLD_MS）。 */
  readonly connectivityThresholdMs?: number;
}

export interface AdminDeviceHandlers {
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  updateMetadata(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function requireDeviceId(req: AdminHttpRequest): string {
  const deviceId = req.params?.deviceId;
  if (!deviceId) throw deviceValidationFailed('deviceId path parameter is required');
  return deviceId;
}

/**
 * Customer 范围由服务端身份上下文注入（规范 §3）：Customer 角色的有效 customerId 恒为
 * actor.customerId；query 中的 customerId 仅用于与 actor scope 比对（不一致 → 403）。
 */
function effectiveCustomerFilter(actor: ActorContext, queryCustomerId: string | undefined): string | undefined {
  if (actor.actorType === 'customer') {
    if (queryCustomerId !== undefined) assertCustomerScope(actor, queryCustomerId);
    return actor.customerId ?? undefined;
  }
  return queryCustomerId;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminDeviceError) {
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

export function createAdminDeviceHandlers(deps: AdminDeviceHandlerDeps): AdminDeviceHandlers {
  const now = deps.now ?? (() => new Date());
  const thresholdMs = deps.connectivityThresholdMs ?? DEFAULT_CONNECTIVITY_THRESHOLD_MS;
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const actor = req.actor as ActorContext;
    const at = now();
    const page = await listDevices(deps.client, {
      customerId: effectiveCustomerFilter(actor, req.query?.customerId),
      siteId: req.query?.siteId,
      region: req.query?.region,
      subregion: req.query?.subregion,
      lifecycleStatus: req.query?.lifecycleStatus,
      operationalStatus: req.query?.operationalStatus,
      connectivity: req.query?.connectivity,
      licenseStatus: req.query?.licenseStatus,
      model: req.query?.model,
      keyword: req.query?.keyword,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
      now: at,
      connectivityThresholdMs: thresholdMs,
    });
    return {
      status: 200,
      body: {
        data: page.items.map((item) => toDeviceDto(item.row, item.contract, at, thresholdMs)),
        meta: { ...meta(req), nextCursor: page.nextCursor },
      },
    };
  });

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const found = await findDeviceById(deps.client, requireDeviceId(req));
    if (!found) throw deviceNotFound();
    const actor = req.actor as ActorContext;
    // Customer 角色仅可见本 Customer 设备；未分配设备（customerId=null）对 Customer 角色不可见
    if (actor.actorType === 'customer') assertCustomerScope(actor, found.row.customerId ?? '');
    return {
      status: 200,
      body: { data: toDeviceDto(found.row, found.contract, now(), thresholdMs), meta: meta(req) },
    };
  });

  const updateMetadata = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:write' },
    async (req) => {
      const view = await updateDeviceMetadata(deps, req.actor as ActorContext, requireDeviceId(req), {
        body: (req.body ?? {}) as Record<string, unknown>,
        ifMatch: req.headers?.['if-match'] ?? req.headers?.['If-Match'],
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
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

  return { list: wrap(list), detail: wrap(detail), updateMetadata: wrap(updateMetadata) };
}
