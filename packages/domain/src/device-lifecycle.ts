/**
 * DOM-01 Device 生命周期与 Operational 状态机（纯领域，无 IO、无 AWS、无 HTTP）。
 *
 * 事实源：
 * - 生命周期迁移表：实施方案 8.1（PendingOnboarding … Retired）；
 * - Operational 轴（Active/Maintenance/Suspended/Retired）：DEC-010 四轴分离，
 *   Maintenance 为独立状态（DEC-001 冻结值：行为限制同 Suspended，但允许维护/同步/遥测/告警/OTA）；
 * - Provisioning 是 OnboardingApproved → Onboarded 的内部步骤，不是外部状态。
 *
 * 产出效果（effects）：state_history 条目与业务审计事件描述符；
 * 持久化由调用方在事务内完成（DB-02）。任何失败抛错且不产生 effects、不修改入参。
 */

// ---------- 状态与角色 ----------

export const LIFECYCLE_STATUSES = [
  'PendingOnboarding',
  'Rejected',
  'OnboardingApproved',
  'Onboarded',
  'Assigned',
  'Licensed',
  'Active',
  'Suspended',
  'Retired',
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const OPERATIONAL_STATUSES = ['Active', 'Maintenance', 'Suspended', 'Retired'] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

export type ActorType = 'ADMIN' | 'DEVICE' | 'SYSTEM';

export interface Actor {
  readonly actorType: ActorType;
  readonly actorId: string;
  /** ADMIN 时的平台角色（DEC-012）。 */
  readonly actorRole?: 'PlatformSuperAdmin' | 'PlatformOperator';
}

export interface DeviceStateSnapshot {
  readonly id: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly operationalStatus: OperationalStatus | null;
}

// ---------- 错误 ----------

export type DeviceStateErrorCode = 'DEVICE_STATE_NOT_ALLOWED' | 'FORBIDDEN' | 'VALIDATION_FAILED';

export class DeviceStateError extends Error {
  override readonly name = 'DeviceStateError';
  constructor(
    readonly code: DeviceStateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------- 迁移定义 ----------

/** 迁移前提条件的上下文入参（由调用方以事实填充）。 */
export interface TransitionContext {
  /** 设备库存/序列号校验通过。 */
  readonly deviceValidated?: boolean;
  /** 证书安装完成。 */
  readonly certificateInstalled?: boolean;
  /** 收到首个 Heartbeat。 */
  readonly firstHeartbeatReceived?: boolean;
  /** 分配目标（必须指向已存在的 Customer 和 Site）。 */
  readonly assignment?: { readonly customerId: string; readonly siteId: string };
  /** 许可证已签发并同步到设备。 */
  readonly licenseIssuedAndSynced?: boolean;
  /** 设备本地验证许可证有效。 */
  readonly licenseVerifiedByDevice?: boolean;
  /** 管理员批准恢复且问题已解决（Suspended → Active）。 */
  readonly issueResolvedApproved?: boolean;
  /** 原因（挂起/退役/拒绝/恢复/维护进出必填）。 */
  readonly reason?: string;
}

interface LifecycleRule {
  readonly to: LifecycleStatus;
  readonly actorTypes: readonly ActorType[];
  readonly actorRoles?: readonly string[];
  readonly requires?: readonly (keyof TransitionContext)[];
  readonly requiresReason?: boolean;
  /** 内部步骤标记（不暴露为外部状态）。 */
  readonly internalSteps?: readonly string[];
  /** 同步派生的 Operational 状态（Active/Suspended/Retired 镜像）。 */
  readonly operationalMirror?: OperationalStatus;
}

const SUPER_ADMIN = ['PlatformSuperAdmin'] as const;
const ADMIN_ROLES = ['PlatformSuperAdmin', 'PlatformOperator'] as const;

/** 生命周期允许迁移表（实施方案 8.1，唯一事实源）。 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleStatus, readonly LifecycleRule[]>> = {
  PendingOnboarding: [
    { to: 'OnboardingApproved', actorTypes: ['ADMIN'], actorRoles: SUPER_ADMIN, requires: ['deviceValidated'] },
    { to: 'Rejected', actorTypes: ['ADMIN'], actorRoles: SUPER_ADMIN, requiresReason: true },
  ],
  Rejected: [],
  OnboardingApproved: [
    {
      to: 'Onboarded',
      actorTypes: ['SYSTEM', 'DEVICE'],
      requires: ['certificateInstalled', 'firstHeartbeatReceived'],
      internalSteps: ['PROVISIONING'],
    },
  ],
  Onboarded: [{ to: 'Assigned', actorTypes: ['ADMIN'], actorRoles: SUPER_ADMIN, requires: ['assignment'] }],
  Assigned: [{ to: 'Licensed', actorTypes: ['SYSTEM'], requires: ['licenseIssuedAndSynced'] }],
  Licensed: [
    { to: 'Active', actorTypes: ['DEVICE'], requires: ['licenseVerifiedByDevice'], operationalMirror: 'Active' },
  ],
  Active: [
    {
      to: 'Suspended',
      actorTypes: ['ADMIN'],
      actorRoles: ADMIN_ROLES,
      requiresReason: true,
      operationalMirror: 'Suspended',
    },
    // BE-IOT-07 Tamper 安全策略自动挂起（SYSTEM actor；必须有策略原因，审计由调用方落）
    {
      to: 'Suspended',
      actorTypes: ['SYSTEM'],
      requiresReason: true,
      operationalMirror: 'Suspended',
    },
    {
      to: 'Retired',
      actorTypes: ['ADMIN'],
      actorRoles: SUPER_ADMIN,
      requiresReason: true,
      operationalMirror: 'Retired',
    },
  ],
  Suspended: [
    {
      to: 'Active',
      actorTypes: ['ADMIN'],
      actorRoles: ADMIN_ROLES,
      requires: ['issueResolvedApproved'],
      requiresReason: true,
      operationalMirror: 'Active',
    },
    {
      to: 'Retired',
      actorTypes: ['ADMIN'],
      actorRoles: SUPER_ADMIN,
      requiresReason: true,
      operationalMirror: 'Retired',
    },
  ],
  Retired: [],
};

interface OperationalRule {
  readonly to: OperationalStatus;
  readonly actorTypes: readonly ActorType[];
  readonly actorRoles?: readonly string[];
  readonly requiresReason: boolean;
}

/** Operational 轴允许迁移：仅 Active ↔ Maintenance；Suspended/Retired 由生命周期迁移镜像派生。 */
export const OPERATIONAL_TRANSITIONS: Readonly<Record<OperationalStatus, readonly OperationalRule[]>> = {
  Active: [{ to: 'Maintenance', actorTypes: ['ADMIN'], actorRoles: ADMIN_ROLES, requiresReason: true }],
  Maintenance: [{ to: 'Active', actorTypes: ['ADMIN'], actorRoles: ADMIN_ROLES, requiresReason: true }],
  Suspended: [],
  Retired: [],
};

// ---------- 效果（产出物描述） ----------

export interface StateHistoryEntry {
  readonly axis: 'lifecycle' | 'operational';
  readonly deviceId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly reason: string | null;
}

export interface AuditEventDescriptor {
  readonly objectType: 'device';
  readonly objectId: string;
  readonly action: string;
  readonly actorId: string;
  readonly actorRole?: string;
  readonly reason: string | null;
  readonly afterValue: {
    readonly lifecycleStatus: LifecycleStatus;
    readonly operationalStatus: OperationalStatus | null;
  };
}

export interface TransitionEffects {
  readonly deviceId: string;
  readonly lifecycle: { readonly from: LifecycleStatus; readonly to: LifecycleStatus } | null;
  readonly operational: { readonly from: OperationalStatus | null; readonly to: OperationalStatus } | null;
  readonly stateHistory: readonly StateHistoryEntry[];
  readonly auditEvent: AuditEventDescriptor;
  readonly internalSteps: readonly string[];
}

// ---------- 校验与执行 ----------

function assertActor(rule: { actorTypes: readonly ActorType[]; actorRoles?: readonly string[] }, actor: Actor): void {
  if (!rule.actorTypes.includes(actor.actorType)) {
    throw new DeviceStateError('FORBIDDEN', `actorType ${actor.actorType} 不允许执行该迁移`);
  }
  if (rule.actorRoles && (!actor.actorRole || !rule.actorRoles.includes(actor.actorRole))) {
    throw new DeviceStateError('FORBIDDEN', `角色 ${actor.actorRole ?? '(无)'} 不允许执行该迁移`);
  }
}

function assertReason(ruleRequiresReason: boolean | undefined, ctx: TransitionContext): void {
  if (ruleRequiresReason && !ctx.reason?.trim()) {
    throw new DeviceStateError('VALIDATION_FAILED', '该迁移必须填写原因');
  }
}

function assertPreconditions(requires: readonly (keyof TransitionContext)[] | undefined, ctx: TransitionContext): void {
  for (const key of requires ?? []) {
    if (ctx[key] === undefined || ctx[key] === null || ctx[key] === false) {
      throw new DeviceStateError('DEVICE_STATE_NOT_ALLOWED', `前置条件未满足: ${key}`);
    }
  }
}

/** 生命周期迁移。非法跳转/越权/缺前提/缺原因均抛 DeviceStateError，不产生 effects。 */
export function transitionLifecycle(
  device: DeviceStateSnapshot,
  to: LifecycleStatus,
  actor: Actor,
  ctx: TransitionContext = {},
): TransitionEffects {
  // 同一 from→to 可有多条规则（不同 actorType，如 Active→Suspended 的 ADMIN/SYSTEM）：
  // 优先匹配 actorType 相符的规则；无匹配则回退首条由 assertActor 抛出 FORBIDDEN
  const candidates = LIFECYCLE_TRANSITIONS[device.lifecycleStatus].filter((r) => r.to === to);
  const rule = candidates.find((r) => r.actorTypes.includes(actor.actorType)) ?? candidates[0];
  if (!rule) {
    throw new DeviceStateError('DEVICE_STATE_NOT_ALLOWED', `生命周期不允许迁移: ${device.lifecycleStatus} → ${to}`);
  }
  assertActor(rule, actor);
  assertReason(rule.requiresReason, ctx);
  assertPreconditions(rule.requires, ctx);

  const reason = ctx.reason?.trim() || null;
  const stateHistory: StateHistoryEntry[] = [
    {
      axis: 'lifecycle',
      deviceId: device.id,
      fromStatus: device.lifecycleStatus,
      toStatus: to,
      actorType: actor.actorType,
      actorId: actor.actorId,
      reason,
    },
  ];
  let operational: TransitionEffects['operational'] = null;
  if (rule.operationalMirror && device.operationalStatus !== rule.operationalMirror) {
    operational = { from: device.operationalStatus, to: rule.operationalMirror };
    stateHistory.push({
      axis: 'operational',
      deviceId: device.id,
      fromStatus: device.operationalStatus,
      toStatus: rule.operationalMirror,
      actorType: actor.actorType,
      actorId: actor.actorId,
      reason,
    });
  }

  return {
    deviceId: device.id,
    lifecycle: { from: device.lifecycleStatus, to },
    operational,
    stateHistory,
    auditEvent: {
      objectType: 'device',
      objectId: device.id,
      action: `device.lifecycle.${device.lifecycleStatus}_to_${to}`,
      actorId: actor.actorId,
      ...(actor.actorRole ? { actorRole: actor.actorRole } : {}),
      reason,
      afterValue: { lifecycleStatus: to, operationalStatus: rule.operationalMirror ?? device.operationalStatus },
    },
    internalSteps: rule.internalSteps ?? [],
  };
}

/** Operational 轴迁移（Active ↔ Maintenance）。 */
export function transitionOperational(
  device: DeviceStateSnapshot,
  to: OperationalStatus,
  actor: Actor,
  ctx: TransitionContext = {},
): TransitionEffects {
  const from = device.operationalStatus;
  if (from === null) {
    throw new DeviceStateError('DEVICE_STATE_NOT_ALLOWED', '设备尚未进入 Active，无 Operational 状态');
  }
  const rule = OPERATIONAL_TRANSITIONS[from].find((r) => r.to === to);
  if (!rule) {
    throw new DeviceStateError('DEVICE_STATE_NOT_ALLOWED', `Operational 不允许迁移: ${from} → ${to}`);
  }
  assertActor(rule, actor);
  assertReason(rule.requiresReason, ctx);

  const reason = ctx.reason?.trim() || null;
  return {
    deviceId: device.id,
    lifecycle: null,
    operational: { from, to },
    stateHistory: [
      {
        axis: 'operational',
        deviceId: device.id,
        fromStatus: from,
        toStatus: to,
        actorType: actor.actorType,
        actorId: actor.actorId,
        reason,
      },
    ],
    auditEvent: {
      objectType: 'device',
      objectId: device.id,
      action: `device.operational.${from}_to_${to}`,
      actorId: actor.actorId,
      ...(actor.actorRole ? { actorRole: actor.actorRole } : {}),
      reason,
      afterValue: { lifecycleStatus: device.lifecycleStatus, operationalStatus: to },
    },
    internalSteps: [],
  };
}
