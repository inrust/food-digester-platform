/**
 * BE-DEV-05 设备控制台 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization → Service。路由：
 * - GET  /api/v1/admin/devices/{deviceId}/console            组合查询（device:read）
 * - GET  /api/v1/admin/devices/{deviceId}/activities         活动日志（device:read）
 * - POST /api/v1/admin/devices/{deviceId}/activities/export  创建异步 CSV 导出（export:create，202）
 * - GET  /api/v1/admin/activity-exports/{exportId}           导出状态/短期 URL（device:read）
 * Customer scope 与 DOM-03 审计在 Service 层强制；跨 Customer → 404。
 * 功能边界：不提供实时视频流（DEC-009），不透传 MQTT 原始消息，导出为异步 Worker
 * （非数据库不限量同步查询）。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { DeviceConsoleError, consoleValidationFailed } from './errors.js';
import { getDeviceConsole } from './service.js';
import { listDeviceActivities } from './activity.js';
import { createActivityExport, getActivityExport } from './export.js';
import type { ActivityExportDeps } from './export.js';
import { parseStrictObject } from '../shared/strict-object.js';

export type AdminDeviceConsoleHandlerDeps = ActivityExportDeps;

export interface AdminDeviceConsoleHandlers {
  getDeviceConsole(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listDeviceActivities(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  createActivityExport(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  getActivityExport(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof DeviceConsoleError) {
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

function requireParam(req: AdminHttpRequest, name: string): string {
  const value = req.params?.[name];
  if (!value) throw consoleValidationFailed(`${name} path parameter is required`);
  return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw consoleValidationFailed(`${field} must be a string`);
  return value;
}

export function createAdminDeviceConsoleHandlers(deps: AdminDeviceConsoleHandlerDeps): AdminDeviceConsoleHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;

  const console_ = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:read' },
    async (req) => {
      const view = await getDeviceConsole(deps, actorOf(req), requireParam(req, 'deviceId'));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const activities = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:read' },
    async (req) => {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const page = await listDeviceActivities(deps, actorOf(req), requireParam(req, 'deviceId'), {
        ...(q.level !== undefined ? { level: q.level } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(q.from !== undefined ? { from: q.from } : {}),
        ...(q.to !== undefined ? { to: q.to } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
    },
  );

  const createExport = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'export:create' },
    async (req) => {
      const body = parseStrictObject(req.body ?? {}, ['level', 'kind', 'from', 'to'], consoleValidationFailed);
      const level = optionalString(body, 'level');
      const kind = optionalString(body, 'kind');
      const from = optionalString(body, 'from');
      const to = optionalString(body, 'to');
      const view = await createActivityExport(deps, actorOf(req), requireParam(req, 'deviceId'), {
        ...(level !== undefined ? { level } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      });
      return { status: 202, body: { data: view, meta: meta(req) } };
    },
  );

  const exportDetail = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:read' },
    async (req) => {
      const view = await getActivityExport(deps, actorOf(req), requireParam(req, 'exportId'));
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

  return {
    getDeviceConsole: wrap(console_),
    listDeviceActivities: wrap(activities),
    createActivityExport: wrap(createExport),
    getActivityExport: wrap(exportDetail),
  };
}
