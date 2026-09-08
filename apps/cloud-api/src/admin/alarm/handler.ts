/**
 * BE-ALM-01 Alarm/Event/Tamper 查询与处理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（查询 alarm:read 全角色 + Customer 租户隔离；
 * 确认/清除 alarm:write = PlatformSuperAdmin/PlatformOperator）→ Service。
 * 路由：
 * - GET  /api/v1/admin/alarms                       列表（severity/status/deviceId/siteId/customerId/时间范围 + 游标）
 * - GET  /api/v1/admin/alarms/{alarmId}             详情（跨 Customer → 404）
 * - POST /api/v1/admin/alarms/{alarmId}/acknowledge 确认（强制原因；重复确认幂等）
 * - POST /api/v1/admin/alarms/{alarmId}/clear       清除（强制原因；重复清除幂等）
 * - GET  /api/v1/admin/events                       Event 只读列表
 * - GET  /api/v1/admin/tamper-events                Tamper 只读列表
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp[,nextCursor]}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminAlarmError, alarmValidationFailed } from './errors.js';
import { acknowledgeAlarm, clearAlarm, getAlarm, listAlarms, listDeviceEvents, listTamperEvents } from './service.js';
import type { AlarmDeps } from './service.js';
import { parseStrictObject } from '../shared/strict-object.js';

export type AdminAlarmHandlerDeps = AlarmDeps;

export interface AdminAlarmHandlers {
  listAlarms(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  alarmDetail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  acknowledge(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  clear(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listEvents(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listTamperEvents(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminAlarmError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  const mapped = mapDbErrorToHttp(err);
  if (mapped.status !== 500) {
    return {
      status: mapped.status,
      body: { error: { code: mapped.code, message: 'The request failed', requestId: req.requestId } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

function requireAlarmId(req: AdminHttpRequest): string {
  const alarmId = req.params?.alarmId;
  if (!alarmId) throw alarmValidationFailed('alarmId path parameter is required');
  return alarmId;
}

function requireReason(req: AdminHttpRequest): string {
  const reason = parseStrictObject(req.body, ['reason'], alarmValidationFailed).reason;
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.trim().length > 500) {
    throw alarmValidationFailed('reason is required and must be a string of 1~500 characters');
  }
  return reason.trim();
}

interface ListQuery {
  customerId?: string;
  siteId?: string;
  deviceId?: string;
  severity?: string;
  status?: string;
  eventType?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

function listFilterOf(req: AdminHttpRequest): ListQuery {
  return (req.query ?? {}) as ListQuery;
}

export function createAdminAlarmHandlers(deps: AdminAlarmHandlerDeps): AdminAlarmHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;

  const listAlarmsH = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'alarm:read' },
    async (req) => {
      const q = listFilterOf(req);
      const page = await listAlarms(deps, actorOf(req), {
        ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
        ...(q.siteId !== undefined ? { siteId: q.siteId } : {}),
        ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
        ...(q.severity !== undefined ? { severity: q.severity } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.from !== undefined ? { from: q.from } : {}),
        ...(q.to !== undefined ? { to: q.to } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
    },
  );

  const alarmDetail = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'alarm:read' },
    async (req) => {
      const view = await getAlarm(deps, actorOf(req), requireAlarmId(req));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const acknowledge = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'alarm:write' },
    async (req) => {
      const result = await acknowledgeAlarm(deps, actorOf(req), {
        alarmId: requireAlarmId(req),
        reason: requireReason(req),
      });
      return {
        status: 200,
        body: { data: { ...result.view, replayed: result.replayed }, meta: meta(req) },
      };
    },
  );

  const clear = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'alarm:write' }, async (req) => {
    const result = await clearAlarm(deps, actorOf(req), {
      alarmId: requireAlarmId(req),
      reason: requireReason(req),
    });
    return {
      status: 200,
      body: { data: { ...result.view, replayed: result.replayed }, meta: meta(req) },
    };
  });

  const listEventsH = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'alarm:read' },
    async (req) => {
      const q = listFilterOf(req);
      const page = await listDeviceEvents(deps, actorOf(req), {
        ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
        ...(q.siteId !== undefined ? { siteId: q.siteId } : {}),
        ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
        ...(q.eventType !== undefined ? { eventType: q.eventType } : {}),
        ...(q.from !== undefined ? { from: q.from } : {}),
        ...(q.to !== undefined ? { to: q.to } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
    },
  );

  const listTamperEventsH = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'alarm:read' },
    async (req) => {
      const q = listFilterOf(req);
      const page = await listTamperEvents(deps, actorOf(req), {
        ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
        ...(q.siteId !== undefined ? { siteId: q.siteId } : {}),
        ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
        ...(q.eventType !== undefined ? { eventType: q.eventType } : {}),
        ...(q.severity !== undefined ? { severity: q.severity } : {}),
        ...(q.from !== undefined ? { from: q.from } : {}),
        ...(q.to !== undefined ? { to: q.to } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
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
    listAlarms: wrap(listAlarmsH),
    alarmDetail: wrap(alarmDetail),
    acknowledge: wrap(acknowledge),
    clear: wrap(clear),
    listEvents: wrap(listEventsH),
    listTamperEvents: wrap(listTamperEventsH),
  };
}
