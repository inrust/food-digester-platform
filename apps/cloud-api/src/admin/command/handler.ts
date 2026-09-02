/**
 * BE-CMD-01 Command 创建与授权 API Handler（框架无关）。
 * BE-CMD-03 扩展：命令列表/详情查询。
 *
 * 接线：AUTH-01 withAuthorization（command:send = PlatformSuperAdmin/PlatformOperator/
 * CustomerAdmin；查询复用 device:read——DEC-012 V1 矩阵无 command:read，不扩矩阵）→ Service。路由：
 * - POST /api/v1/admin/devices/{deviceId}/commands  创建并授权（201；meta.id 幂等重放 200）
 * - GET  /api/v1/admin/commands                     列表（筛选 + 键集游标分页）
 * - GET  /api/v1/admin/commands/{commandId}         详情（含 attempts/acks 时间线）
 * 功能边界：不发布 MQTT，不执行设备动作。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminCommandError, commandValidationFailed } from './errors.js';
import { createCommand } from './service.js';
import type { CommandDeps } from './service.js';
import { getCommandDetail, listCommands } from './query-service.js';

export type AdminCommandHandlerDeps = CommandDeps;

export interface AdminCommandHandlers {
  createCommand(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listCommands(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  getCommand(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminCommandError) {
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

export function createAdminCommandHandlers(deps: AdminCommandHandlerDeps): AdminCommandHandlers {
  const now = deps.now ?? (() => new Date());

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'command:send' }, async (req) => {
    const deviceId = req.params?.deviceId;
    if (!deviceId) throw commandValidationFailed('deviceId path parameter is required');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.command !== 'string') throw commandValidationFailed('command is required');
    const confirmationRaw = body.confirmation as Record<string, unknown> | undefined;
    const result = await createCommand(deps, req.actor as ActorContext, {
      deviceId,
      command: body.command,
      timeoutSec: body.timeoutSec as number,
      ...(typeof body.commandId === 'string' ? { commandId: body.commandId } : {}),
      ...(typeof body.remarks === 'string' ? { remarks: body.remarks } : {}),
      ...(confirmationRaw !== undefined && confirmationRaw !== null
        ? {
            confirmation: {
              confirmText: confirmationRaw.confirmText as string,
              confirmedAt: confirmationRaw.confirmedAt as string,
            },
          }
        : {}),
    });
    return {
      status: result.replayed ? 200 : 201,
      body: {
        data: result,
        meta: { requestId: req.requestId, timestamp: now().toISOString() },
      },
    };
  });

  interface ListQuery {
    customerId?: string;
    deviceId?: string;
    status?: string;
    command?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: string;
  }

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const q = (req.query ?? {}) as ListQuery;
    const page = await listCommands(deps, req.actor as ActorContext, {
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.command !== undefined ? { command: q.command } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return {
      status: 200,
      body: {
        data: page.items,
        meta: { requestId: req.requestId, timestamp: now().toISOString(), nextCursor: page.nextCursor },
      },
    };
  });

  const get = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const commandId = req.params?.commandId;
    if (!commandId) throw commandValidationFailed('commandId path parameter is required');
    const view = await getCommandDetail(deps, req.actor as ActorContext, commandId);
    return {
      status: 200,
      body: { data: view, meta: { requestId: req.requestId, timestamp: now().toISOString() } },
    };
  });

  return {
    createCommand: async (req) => {
      try {
        return await create(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    },
    listCommands: async (req) => {
      try {
        return await list(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    },
    getCommand: async (req) => {
      try {
        return await get(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    },
  };
}
