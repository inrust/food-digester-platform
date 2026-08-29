/**
 * BE-CON-01 Contract 状态领域规则（纯领域，无 IO）。
 *
 * 事实源：DEC-007（Contract 管商业租期和设备关联；创建 Contract 不自动激活 License）。
 * - 状态机：DRAFT → EFFECTIVE（显式 activate）；EFFECTIVE → EXPIRING_SOON → EXPIRED
 *   （时间派生 evaluateContractAt，到期窗口 30 天暂定值）；非 TERMINATED → TERMINATED
 *   （显式 terminate，强制原因）；TERMINATED 为终态。
 * - 续约（renew）：EFFECTIVE/EXPIRING_SOON/EXPIRED 延长 endAt，状态按新窗口重新推导；
 *   DRAFT 直接编辑 endAt，TERMINATED 不可续约。
 * - 边界：不管理价格/开票/收付款/电子签署；不自动创建、激活或续期 License。
 * - 不负责定时扫描：时间派生由可测试的 evaluateContractAt(at) 完成，读取时点派生展示。
 */

export const CONTRACT_STATUSES = ['DRAFT', 'EFFECTIVE', 'EXPIRING_SOON', 'EXPIRED', 'TERMINATED'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** 即将到期窗口（天；暂定值，可整体替换）。 */
export const CONTRACT_EXPIRING_SOON_WINDOW_DAYS = 30;

export class ContractStateError extends Error {
  override readonly name = 'ContractStateError';
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

export interface ContractSnapshot {
  readonly status: ContractStatus;
  readonly startAt: Date;
  readonly endAt: Date;
}

/** 窗口校验：startAt 必须早于 endAt。 */
export function assertContractWindow(startAt: Date, endAt: Date): void {
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new ContractStateError('VALIDATION_FAILED', 'startAt and endAt must be valid timestamps');
  }
  if (startAt.getTime() >= endAt.getTime()) {
    throw new ContractStateError('VALIDATION_FAILED', 'startAt must be before endAt');
  }
}

/**
 * 时间派生（DRAFT/TERMINATED/EXPIRED 粘性不派生；EXPIRED 仅经 renew 离开）：
 * at >= endAt → EXPIRED；at >= endAt - 窗口 → EXPIRING_SOON；否则 EFFECTIVE。
 */
export function deriveContractStatus(snapshot: ContractSnapshot, at: Date): ContractStatus {
  if (snapshot.status === 'DRAFT' || snapshot.status === 'TERMINATED' || snapshot.status === 'EXPIRED') {
    return snapshot.status;
  }
  if (at.getTime() >= snapshot.endAt.getTime()) return 'EXPIRED';
  const windowStart = snapshot.endAt.getTime() - CONTRACT_EXPIRING_SOON_WINDOW_DAYS * 86_400_000;
  if (at.getTime() >= windowStart) return 'EXPIRING_SOON';
  return 'EFFECTIVE';
}

/** 可测试的时间派生：状态变化时返回目标状态，无变化返回 null（DRAFT/TERMINATED 不派生）。 */
export function evaluateContractAt(snapshot: ContractSnapshot, at: Date): ContractStatus | null {
  const derived = deriveContractStatus(snapshot, at);
  return derived === snapshot.status ? null : derived;
}

/** 激活前置：仅 DRAFT → EFFECTIVE（显式动作）。 */
export function assertContractActivatable(status: ContractStatus): void {
  if (status !== 'DRAFT') {
    throw new ContractStateError('CONFLICT', 'Only a DRAFT contract can be activated');
  }
}

/** 终止前置：TERMINATED 为终态（重复终止 → 409）。 */
export function assertContractTerminatable(status: ContractStatus): void {
  if (status === 'TERMINATED') {
    throw new ContractStateError('CONFLICT', 'The contract is already terminated');
  }
}

/**
 * 续约：EFFECTIVE/EXPIRING_SOON/EXPIRED 可续约；newEndAt 必须晚于当前 endAt；
 * 返回续约后状态（按新窗口重新推导，调用时点 at）。
 */
export function renewContractWindow(snapshot: ContractSnapshot, newEndAt: Date, at: Date): ContractStatus {
  if (snapshot.status === 'DRAFT') {
    throw new ContractStateError('CONFLICT', 'A DRAFT contract cannot be renewed; edit endAt instead');
  }
  if (snapshot.status === 'TERMINATED') {
    throw new ContractStateError('CONFLICT', 'A terminated contract cannot be renewed');
  }
  assertContractWindow(snapshot.startAt, newEndAt);
  if (newEndAt.getTime() <= snapshot.endAt.getTime()) {
    throw new ContractStateError('VALIDATION_FAILED', 'newEndAt must be later than the current endAt');
  }
  return deriveContractStatus({ ...snapshot, status: 'EFFECTIVE', endAt: newEndAt }, at);
}

/** 编辑前置：TERMINATED 不可编辑；startAt/endAt 仅 DRAFT 可直接编辑（续约走 renew）。 */
export function assertContractEditable(
  status: ContractStatus,
  fields: { readonly touchesStartAt: boolean; readonly touchesEndAt: boolean },
): void {
  if (status === 'TERMINATED') {
    throw new ContractStateError('CONFLICT', 'A terminated contract cannot be edited');
  }
  if ((fields.touchesStartAt || fields.touchesEndAt) && status !== 'DRAFT') {
    throw new ContractStateError('CONFLICT', 'startAt/endAt can only be edited while DRAFT; use renew to extend');
  }
}

// ---------- 设备关联（BE-CON-02） ----------

/** 可关联状态：EXPIRED/TERMINATED 不可新增关联（DRAFT/EFFECTIVE/EXPIRING_SOON 可）。 */
export function assertContractAssociatable(status: ContractStatus): void {
  if (status === 'EXPIRED' || status === 'TERMINATED') {
    throw new ContractStateError('CONFLICT', 'An expired or terminated contract cannot accept device associations');
  }
}

/** 关联窗口：validFrom < validTo（validTo null = 无限期仅限 DRAFT 前禁用，调用方须闭合）且必须落在合同窗口内。 */
export function assertAssociationWindow(
  contract: { readonly startAt: Date; readonly endAt: Date },
  validFrom: Date,
  validTo: Date,
): void {
  assertContractWindow(validFrom, validTo);
  if (validFrom.getTime() < contract.startAt.getTime() || validTo.getTime() > contract.endAt.getTime()) {
    throw new ContractStateError('VALIDATION_FAILED', 'The association window must be within the contract window');
  }
}

/** 区间重叠判定（[from,to) 半开区间；用于同设备有效关联不重叠的预检，DB 排他约束兜底）。 */
export function windowsOverlap(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): boolean {
  return aFrom.getTime() < bTo.getTime() && bFrom.getTime() < aTo.getTime();
}
