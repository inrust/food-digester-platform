/**
 * DOM-02 License 状态机与商业规则（纯领域，无 IO）。
 *
 * 事实源：实施方案 11.3。
 * - 状态机：NoLicense → Draft → Issued → Active → ExpiringSoon → Renewed → Active；
 *   Active/ExpiringSoon → Expired（时间派生）；Active/Expired → Revoked。
 * - NoLicense 为虚拟初始状态，不落库（DB-01 约定）；licenses 行从 Draft 开始。
 * - 商业规则：已 Onboarded 但未分配 Customer 的设备不可运行；已分配但无有效
 *   License 的设备不可运行；只有已分配且已许可的设备才可进入 Active。
 * - 一个设备仅一个有效 License：DB 层由部分唯一索引兜底（DB-01），领域层经
 *   ctx.noOtherValidLicense 事实拒绝并发放行。
 * - 不负责定时扫描到期：时间派生由可测试的 evaluateAt(now) 完成，BE-LIC-01 调用。
 */
import { DeviceStateError } from './device-lifecycle.js';

// ---------- 状态与 Entitlement ----------

export const LICENSE_STATUSES = ['Draft', 'Issued', 'Active', 'ExpiringSoon', 'Renewed', 'Expired', 'Revoked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** Entitlement 控制 Remote Control、OTA、ESG Reporting。 */
export const ENTITLEMENT_CODES = ['REMOTE_CONTROL', 'OTA_UPDATE', 'ESG_REPORTING'] as const;
export type EntitlementCode = (typeof ENTITLEMENT_CODES)[number];

export interface LicenseSnapshot {
  readonly id: string;
  readonly deviceId: string;
  readonly status: LicenseStatus;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly entitlements: readonly EntitlementCode[];
}

export interface LicenseActor {
  readonly actorType: 'ADMIN' | 'SYSTEM' | 'DEVICE';
  readonly actorId: string;
  readonly actorRole?: 'PlatformSuperAdmin' | 'PlatformOperator';
}

export class LicenseStateError extends Error {
  override readonly name = 'LicenseStateError';
  constructor(
    readonly code: 'DEVICE_STATE_NOT_ALLOWED' | 'FORBIDDEN' | 'VALIDATION_FAILED' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

// ---------- 效果 ----------

export interface LicenseTransitionEffects {
  readonly licenseId: string;
  readonly from: LicenseStatus;
  readonly to: LicenseStatus;
  /** 重复请求的幂等回放：状态未变、仅返回确定结果。 */
  readonly idempotentReplay: boolean;
  readonly historyEntry: {
    readonly licenseId: string;
    readonly fromStatus: LicenseStatus | null;
    readonly toStatus: LicenseStatus;
    readonly actorId: string;
    readonly reason: string | null;
  };
  readonly auditEvent: {
    readonly objectType: 'license';
    readonly objectId: string;
    readonly action: string;
    readonly actorId: string;
    readonly actorRole?: string;
    readonly reason: string | null;
    readonly afterValue: { readonly status: LicenseStatus };
  };
  /** 状态变化须触发 LICENSE_CHANGED Notification（BE-LIC-01 投递）。 */
  readonly notification: { readonly type: 'LICENSE_CHANGED'; readonly deviceId: string };
}

// ---------- 迁移表 ----------

interface LicenseRule {
  readonly to: LicenseStatus;
  readonly actorTypes: readonly LicenseActor['actorType'][];
  readonly actorRoles?: readonly string[];
  readonly requiresReason?: boolean;
}

const ADMIN_ROLES = ['PlatformSuperAdmin', 'PlatformOperator'] as const;

/** 允许迁移表（实施方案 11.3；Active/ExpiringSoon → Expired 由 evaluateAt 以 SYSTEM 触发）。 */
export const LICENSE_TRANSITIONS: Readonly<Record<LicenseStatus, readonly LicenseRule[]>> = {
  Draft: [{ to: 'Issued', actorTypes: ['ADMIN'], actorRoles: ADMIN_ROLES }],
  Issued: [{ to: 'Active', actorTypes: ['SYSTEM', 'DEVICE'] }],
  Active: [
    { to: 'ExpiringSoon', actorTypes: ['SYSTEM'] },
    { to: 'Expired', actorTypes: ['SYSTEM'] },
    { to: 'Revoked', actorTypes: ['ADMIN'], actorRoles: ADMIN_ROLES, requiresReason: true },
  ],
  ExpiringSoon: [
    { to: 'Renewed', actorTypes: ['ADMIN'], actorRoles: ADMIN_ROLES },
    { to: 'Expired', actorTypes: ['SYSTEM'] },
  ],
  Renewed: [{ to: 'Active', actorTypes: ['SYSTEM'] }],
  Expired: [{ to: 'Revoked', actorTypes: ['ADMIN'], actorRoles: ADMIN_ROLES, requiresReason: true }],
  Revoked: [],
};

/** 有效 License（可支撑设备运行）：Issued/Active/ExpiringSoon/Renewed 且在有效期内。 */
export function isLicenseEffective(license: LicenseSnapshot, now: Date): boolean {
  const effectiveStatus = ['Issued', 'Active', 'ExpiringSoon', 'Renewed'].includes(license.status);
  return effectiveStatus && license.validFrom <= now && now < license.validTo;
}

// ---------- 创建与迁移 ----------

export interface CreateDraftInput {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly entitlements: readonly EntitlementCode[];
  readonly actor: LicenseActor;
}

export interface CreateDraftContext {
  /** 调用方已确认该设备无其他有效 License（DB 唯一索引兜底）。 */
  readonly noOtherValidLicense: boolean;
}

/** 从 NoLicense 创建 Draft。 */
export function createLicenseDraft(input: CreateDraftInput, ctx: CreateDraftContext): LicenseTransitionEffects {
  if (input.actor.actorType !== 'ADMIN' || !input.actor.actorRole || !ADMIN_ROLES.includes(input.actor.actorRole)) {
    throw new LicenseStateError('FORBIDDEN', '仅平台管理员/操作员可创建 License');
  }
  if (!ctx.noOtherValidLicense) {
    throw new LicenseStateError('CONFLICT', `设备 ${input.deviceId} 已存在有效 License`);
  }
  if (!(input.validFrom < input.validTo)) {
    throw new LicenseStateError('VALIDATION_FAILED', 'validFrom 必须早于 validTo');
  }
  if (input.entitlements.length === 0) {
    throw new LicenseStateError('VALIDATION_FAILED', 'Entitlement 不能为空');
  }
  for (const code of input.entitlements) {
    if (!ENTITLEMENT_CODES.includes(code)) {
      throw new LicenseStateError('VALIDATION_FAILED', `未知 Entitlement: ${code}`);
    }
  }
  return buildEffects(input.id, input.deviceId, 'Draft', 'Draft', input.actor, false, null);
}

export interface TransitionLicenseContext {
  readonly reason?: string;
}

/** 状态机迁移。非法跳转/越权/缺原因抛 LicenseStateError，不产生 effects。 */
export function transitionLicense(
  license: LicenseSnapshot,
  to: LicenseStatus,
  actor: LicenseActor,
  ctx: TransitionLicenseContext = {},
): LicenseTransitionEffects {
  const rule = LICENSE_TRANSITIONS[license.status].find((r) => r.to === to);
  if (!rule) {
    throw new LicenseStateError('DEVICE_STATE_NOT_ALLOWED', `License 不允许迁移: ${license.status} → ${to}`);
  }
  if (!rule.actorTypes.includes(actor.actorType)) {
    throw new LicenseStateError('FORBIDDEN', `actorType ${actor.actorType} 不允许执行该迁移`);
  }
  if (rule.actorRoles && (!actor.actorRole || !rule.actorRoles.includes(actor.actorRole))) {
    throw new LicenseStateError('FORBIDDEN', `角色 ${actor.actorRole ?? '(无)'} 不允许执行该迁移`);
  }
  if (rule.requiresReason && !ctx.reason?.trim()) {
    throw new LicenseStateError('VALIDATION_FAILED', '该迁移必须填写原因');
  }
  return buildEffects(license.id, license.deviceId, license.status, to, actor, false, ctx.reason?.trim() || null);
}

function buildEffects(
  licenseId: string,
  deviceId: string,
  from: LicenseStatus,
  to: LicenseStatus,
  actor: LicenseActor,
  idempotentReplay: boolean,
  reason: string | null,
): LicenseTransitionEffects {
  return {
    licenseId,
    from,
    to,
    idempotentReplay,
    historyEntry: {
      licenseId,
      fromStatus: from === to ? null : from,
      toStatus: to,
      actorId: actor.actorId,
      reason,
    },
    auditEvent: {
      objectType: 'license',
      objectId: licenseId,
      action: `license.${from}_to_${to}`,
      actorId: actor.actorId,
      ...(actor.actorRole ? { actorRole: actor.actorRole } : {}),
      reason,
      afterValue: { status: to },
    },
    notification: { type: 'LICENSE_CHANGED', deviceId },
  };
}

// ---------- 续期（含重复请求幂等） ----------

/**
 * 续期：ExpiringSoon → Renewed 并延长 validTo。
 * 重复请求确定结果：已 Renewed 且 newValidTo 相同 → 幂等回放（idempotentReplay=true）；
 * 已 Renewed 但 newValidTo 不同 → CONFLICT。
 */
export function renewLicense(
  license: LicenseSnapshot,
  newValidTo: Date,
  actor: LicenseActor,
): LicenseTransitionEffects {
  if (license.status === 'Renewed') {
    if (license.validTo.getTime() === newValidTo.getTime()) {
      return buildEffects(license.id, license.deviceId, 'Renewed', 'Renewed', actor, true, null);
    }
    throw new LicenseStateError('CONFLICT', `License 已续期至 ${license.validTo.toISOString()}，与新请求不一致`);
  }
  if (!(newValidTo > license.validTo)) {
    throw new LicenseStateError('VALIDATION_FAILED', '续期后的 validTo 必须晚于当前 validTo');
  }
  return transitionLicense(license, 'Renewed', actor);
}

// ---------- 到期派生（可注入时间） ----------

export const DEFAULT_EXPIRING_SOON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/**
 * 时间派生：Active → ExpiringSoon（进入到期窗口）/ Expired（超过 validTo）；
 * ExpiringSoon → Expired。其余状态不随时间变化。返回 null 表示无需迁移。
 */
export function evaluateLicenseAt(
  license: LicenseSnapshot,
  now: Date,
  expiringSoonWindowMs: number = DEFAULT_EXPIRING_SOON_WINDOW_MS,
): LicenseTransitionEffects | null {
  let target: LicenseStatus | null = null;
  if (license.status === 'Active') {
    if (now >= license.validTo) target = 'Expired';
    else if (license.validTo.getTime() - now.getTime() <= expiringSoonWindowMs) target = 'ExpiringSoon';
  } else if (license.status === 'ExpiringSoon') {
    if (now >= license.validTo) target = 'Expired';
  }
  if (!target) return null;
  return transitionLicense(license, target, { actorType: 'SYSTEM', actorId: 'license-evaluator' });
}

// ---------- 商业规则：Assignment + License 才允许设备 Active ----------

export interface DeviceRunnableFacts {
  /** 设备存在 ACTIVE 的 Assignment（已分配 Customer 和 Site）。 */
  readonly hasActiveAssignment: boolean;
  readonly license: LicenseSnapshot | null;
}

/**
 * 校验设备可进入 Active：已分配且持有有效 License。
 * 供 DOM-01 Licensed → Active 迁移与 BE-DEV 激活路径复用。
 */
export function assertDeviceRunnable(facts: DeviceRunnableFacts, now: Date): void {
  if (!facts.hasActiveAssignment) {
    throw new DeviceStateError('DEVICE_STATE_NOT_ALLOWED', '设备未分配 Customer/Site，不可运行');
  }
  if (!facts.license || !isLicenseEffective(facts.license, now)) {
    throw new DeviceStateError('DEVICE_STATE_NOT_ALLOWED', '设备无有效 License，不可运行');
  }
}
