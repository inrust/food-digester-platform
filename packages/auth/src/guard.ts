/**
 * AUTH-01 授权 Guard 与 Decorator（框架无关）。
 *
 * - requirePermission：角色越权 → 403；
 * - assertCustomerScope：Customer actor 访问其他 Customer → 403（platform actor 不受限）；
 * - withAuthorization：路由级装饰器（HOF），按顺序执行 身份 → 权限点 → Customer scope，
 *   供 cloud-api 的 Lambda/NestJS 适配层包装 Handler 使用。
 */
import { unauthenticated, forbidden } from './errors.js';
import { hasPermission } from './permissions.js';
import type { Permission } from './permissions.js';
import type { ActorContext } from './roles.js';
import { normalizeAuditIp, normalizeAuditUserAgent, runWithContext } from '@fdp/database';

/** 角色越权检查：actor 任一角色持有权限点即放行，否则 403。 */
export function requirePermission(actor: ActorContext, permission: Permission): void {
  const granted = actor.roles.some((role) => hasPermission(role, permission));
  if (!granted) {
    throw forbidden(`Missing required permission: ${permission}`);
  }
}

/** Customer scope 校验：Customer A 无法读取或修改 Customer B 数据；platform actor 跨 Customer 放行。 */
export function assertCustomerScope(actor: ActorContext, customerId: string): void {
  if (actor.actorType === 'platform') return;
  if (actor.customerId !== customerId) {
    throw forbidden('Cross-customer access is not allowed');
  }
}

/** 携带可选 actor 的最小请求形状（适配层在调用前注入 actor）。 */
export interface AuthenticatedRequest {
  readonly actor?: ActorContext | undefined;
  /** 以下元数据由可信 HTTP/Lambda 适配层注入，禁止从业务 body 提取。 */
  readonly requestId?: string | undefined;
  readonly sourceIp?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface AuthorizationRule<TReq> {
  /** 所需权限点（PERMISSION_MATRIX）。 */
  readonly permission?: Permission;
  /**
   * 从请求提取目标 Customer ID（如路径/查询参数）；返回 undefined 表示该路由无 Customer 维度。
   * 注意：customerId 只能用于与 actor scope 比对，业务查询必须使用 actor.customerId 而非入参。
   */
  readonly customerOf?: (req: TReq) => string | undefined;
}

/** 授权 Decorator：依次执行 身份存在 → 权限点 → Customer scope，全部通过后调用业务 Handler。 */
export function withAuthorization<TReq extends AuthenticatedRequest, TRes>(
  rule: AuthorizationRule<TReq>,
  handler: (req: TReq & { readonly actor: ActorContext }) => TRes | Promise<TRes>,
): (req: TReq) => Promise<TRes> {
  return async (req) => {
    const actor = req.actor;
    if (!actor) throw unauthenticated();
    if (rule.permission) requirePermission(actor, rule.permission);
    if (rule.customerOf) {
      const customerId = rule.customerOf(req);
      if (customerId !== undefined) assertCustomerScope(actor, customerId);
    }
    const ip = normalizeAuditIp(req.sourceIp);
    const userAgent = normalizeAuditUserAgent(req.userAgent);
    return runWithContext(
      {
        actorId: actor.actorId,
        ...(actor.roles[0] ? { actorRole: actor.roles[0] } : {}),
        ...(actor.customerId ? { customerId: actor.customerId } : {}),
        ...(req.requestId ? { requestId: req.requestId } : {}),
        ...(ip ? { ip } : {}),
        ...(userAgent ? { userAgent } : {}),
      },
      () => handler({ ...req, actor }),
    );
  };
}
