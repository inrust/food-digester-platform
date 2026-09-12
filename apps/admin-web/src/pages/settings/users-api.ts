/**
 * FE-16 用户/角色 API 装配（BE-RBAC-01）。
 *
 * - inviteUser：Cognito 生成临时凭证——请求体不含 password（装配层类型即无此字段；
 *   未知字段/永久密码由服务端严格解析 400 拒绝）；
 * - assignUserRoles：整体替换角色集（自我提权/提升平台角色越权/最后一个 SuperAdmin 移除 → 403/409）；
 * - disableUser/triggerUserPasswordReset：无请求体；重置响应仅含 userId/status（不含密码材料）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { Role } from '@fdp/auth/browser';
import type { PasswordResetResult, UserStatus, UserView } from './types.js';

export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export interface UserListFilter {
  readonly roleType?: 'platform' | 'customer' | null;
  readonly status?: UserStatus | null;
  readonly customerId?: string | null;
  /** email/displayName 模糊匹配。 */
  readonly q?: string | null;
}

function buildQuery(filter: UserListFilter, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  if (cursor !== undefined && cursor !== '') params.set('cursor', cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export async function listUsers(api: ApiClient, filter: UserListFilter, cursor?: string): Promise<Page<UserView>> {
  const response = await api.request<{ data: UserView[]; meta: { nextCursor: string | null } }>(
    `/admin/users${buildQuery(filter, cursor)}`,
  );
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

/** 邀请输入（不含 password：临时凭证由 Cognito 生成并发送）。 */
export interface InviteUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  /** Customer 角色必填；平台角色必须省略。 */
  readonly customerId?: string;
}

export async function inviteUser(api: ApiClient, input: InviteUserInput): Promise<UserView> {
  const body: Record<string, unknown> = {
    email: input.email,
    displayName: input.displayName,
    roles: [...input.roles],
  };
  if (input.customerId !== undefined) body['customerId'] = input.customerId;
  const response = await api.request<{ data: UserView }>('/admin/users', { method: 'POST', body });
  return response.data;
}

export async function assignUserRoles(api: ApiClient, userId: string, roles: readonly Role[]): Promise<UserView> {
  const response = await api.request<{ data: UserView }>(`/admin/users/${encodeURIComponent(userId)}/roles`, {
    method: 'PUT',
    body: { roles: [...roles] },
  });
  return response.data;
}

export async function setUserScope(api: ApiClient, userId: string, customerId: string): Promise<UserView> {
  const response = await api.request<{ data: UserView }>(`/admin/users/${encodeURIComponent(userId)}/scope`, {
    method: 'PUT',
    body: { customerId },
  });
  return response.data;
}

export async function disableUser(api: ApiClient, userId: string): Promise<UserView> {
  const response = await api.request<{ data: UserView }>(`/admin/users/${encodeURIComponent(userId)}/disable`, {
    method: 'POST',
  });
  return response.data;
}

export async function triggerUserPasswordReset(api: ApiClient, userId: string): Promise<PasswordResetResult> {
  const response = await api.request<{ data: PasswordResetResult }>(
    `/admin/users/${encodeURIComponent(userId)}/password-reset`,
    { method: 'POST' },
  );
  return response.data;
}
