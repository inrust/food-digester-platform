/**
 * FE-09 Device User 数据类型：镜像 admin-device-user-api.json（BE-DUSR-01/02）。
 *
 * DEC-004：password 仅写接口受控接收（writeOnly），任何查询响应不含 password/passwordHash；
 * 本类型层不含任何密码字段，从类型上保证“不回显”。
 */

export type DeviceUserStatus = 'ACTIVE' | 'DISABLED';

export interface DeviceUserView {
  readonly deviceUserId: string;
  readonly customerId: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly status: DeviceUserStatus;
  /** 同步版本（兼 If-Match 乐观锁）。 */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeviceUserListItemView extends DeviceUserView {
  readonly activeDeviceCount: number;
}

export interface DeviceUserAssignmentView {
  readonly assignmentId: string;
  readonly deviceId: string;
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly assignedAt: string;
  readonly revokedAt: string | null;
}

export interface DeviceUserDetailView extends DeviceUserView {
  readonly assignments: readonly DeviceUserAssignmentView[];
  readonly syncStates?: readonly {
    readonly deviceId: string;
    readonly entityVersion: number | null;
    readonly notificationStatus: 'PENDING' | 'PUBLISHED' | 'FAILED' | 'NOT_REQUESTED';
    readonly notificationPublishedAt: string | null;
    readonly deliveredEntityVersion: number | null;
    readonly snapshotStatus: 'NOT_SERVED' | 'SERVED' | 'ACKNOWLEDGED';
    readonly snapshotServedAt: string | null;
    readonly deviceReportedLastSyncAt: string | null;
    readonly deviceApplyStatus: 'NOT_REPORTED';
  }[];
}

export interface AssignResultView {
  readonly deviceUserId: string;
  readonly deviceIds: readonly string[];
  readonly assignments: readonly DeviceUserAssignmentView[];
}

export interface RevokeResultView {
  readonly deviceUserId: string;
  readonly deviceIds: readonly string[];
}
