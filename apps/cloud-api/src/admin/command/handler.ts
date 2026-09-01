/**
 * BE-CMD-01 Command 创建与授权 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（command:send = PlatformSuperAdmin/PlatformOperator/
 * CustomerAdmin）→ Service。路由：
 * - POST /api/v1/admin/devices/{deviceId}/commands  创建并授权（201；meta.id 幂等重放 200）
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

export type AdminCommandHandlerDeps = CommandDeps;

export interface AdminCommandHandlers {
  createCommand(req: AdminHttpRequest): Promise<AdminHttpResponse>;
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

  return {
    createCommand: async (req) => {
      try {
        return await create(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    },
  };
}
