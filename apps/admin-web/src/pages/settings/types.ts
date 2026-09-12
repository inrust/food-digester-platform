/**
 * FE-16 用户/角色与业务设置数据类型：镜像 admin-user-api.json（BE-RBAC-01）与
 * admin-settings-api.json（BE-SET-01）。
 */
import type { Role } from '@fdp/auth/browser';

export type UserStatus = 'INVITED' | 'ACTIVE' | 'DISABLED';

/** 用户视图（不含 cognitoSub/密码/凭证材料）。 */
export interface UserView {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly mfaEnabled: boolean;
  readonly roles: readonly Role[];
  /** Customer 角色用户所属 Customer；平台角色恒为 null。 */
  readonly customerId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 密码重置结果（不含密码 Hash 或现有密码；临时凭证由 Cognito 直接发送给用户）。 */
export interface PasswordResetResult {
  readonly userId: string;
  readonly status: 'RESET_TRIGGERED';
}

// ---------- 业务设置（BE-SET-01） ----------

/** 封闭 key 集（其他 key 不可创建）。 */
export type SettingKey =
  'alarm.thresholds' | 'command.confirmation' | 'dictionary.displayNames' | 'notification.business';

/** ACTIVE=已有唯一运行时消费方；STORED_ONLY=仅校验/版本/审计/存储，更新不代表业务行为生效。 */
export type SettingRuntimeStatus = 'ACTIVE' | 'STORED_ONLY';

export interface SettingView {
  readonly key: SettingKey;
  readonly value: unknown;
  /** 乐观锁版本（更新时必须在请求体回传，不匹配 → 409）。 */
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
  readonly runtimeStatus: SettingRuntimeStatus;
  readonly runtimeConsumer: string | null;
}

export interface ListState<T> {
  readonly rows: readonly T[] | null;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly nextCursor?: string | null;
}
