/**
 * DOM-02 扩展：远程命令创建与授权决策（BE-CMD-01）。
 *
 * 事实源：contracts/mqtt/command-catalog.json（CT-04，catalogVersion 1.0.1，22 个命令白名单；
 * allowedStatuses 基于设备 Operational 状态；MAINTENANCE 暂按 Suspended 限制——DEC-001 暂定映射
 * 已内嵌于目录）。契约目录不被 packages 引用（同耗材先例），此处复制常量并由
 * packages/domain/test/command.test.ts 与契约目录做一致性校验。
 *
 * 本模块纯函数：不做 IO、不发布 MQTT、不执行设备动作（BE-CMD-01 功能边界）。
 */

// ---------- 错误 ----------

export class CommandError extends Error {
  override readonly name = 'CommandError';
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'DEVICE_STATE_NOT_ALLOWED',
    message: string,
  ) {
    super(message);
  }
}

// ---------- 命令目录（与 contracts/mqtt/command-catalog.json 1.0.1 一致，由一致性测试保证） ----------

export const COMMAND_CATEGORIES = ['MACHINE', 'MOTOR', 'HEATING', 'VENTILATION', 'DISCHARGE', 'DEVICE'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/** 门控状态（目录 allowedStatuses 取值；大写，与设备 Operational 状态映射后比较）。 */
export type CommandGateStatus = 'ACTIVE' | 'MAINTENANCE' | 'SUSPENDED' | 'RETIRED';

export interface CommandSpec {
  readonly command: string;
  readonly category: CommandCategory;
  readonly highRisk: boolean;
  readonly allowedStatuses: readonly CommandGateStatus[];
}

const ACTIVE_ONLY = ['ACTIVE'] as const;
const SAFE_STOP_SET = ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'] as const;

export const COMMAND_CATALOG: readonly CommandSpec[] = [
  { command: 'START', category: 'MACHINE', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  { command: 'STOP', category: 'MACHINE', highRisk: false, allowedStatuses: SAFE_STOP_SET },
  { command: 'PAUSE', category: 'MACHINE', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  { command: 'RESUME', category: 'MACHINE', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  { command: 'EMERGENCY_STOP', category: 'MACHINE', highRisk: true, allowedStatuses: SAFE_STOP_SET },
  { command: 'AGITATOR_FORWARD', category: 'MOTOR', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  { command: 'AGITATOR_REVERSE', category: 'MOTOR', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  { command: 'AGITATOR_STOP', category: 'MOTOR', highRisk: true, allowedStatuses: SAFE_STOP_SET },
  { command: 'HEATING_ON', category: 'HEATING', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  { command: 'HEATING_OFF', category: 'HEATING', highRisk: true, allowedStatuses: SAFE_STOP_SET },
  { command: 'SET_TARGET_TEMPERATURE', category: 'HEATING', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  { command: 'EXHAUST_ON', category: 'VENTILATION', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  { command: 'EXHAUST_OFF', category: 'VENTILATION', highRisk: false, allowedStatuses: SAFE_STOP_SET },
  { command: 'AIR_SUPPLY_ON', category: 'VENTILATION', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  { command: 'AIR_SUPPLY_OFF', category: 'VENTILATION', highRisk: false, allowedStatuses: SAFE_STOP_SET },
  { command: 'DISCHARGE_START', category: 'DISCHARGE', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  { command: 'DISCHARGE_STOP', category: 'DISCHARGE', highRisk: true, allowedStatuses: SAFE_STOP_SET },
  { command: 'REBOOT', category: 'DEVICE', highRisk: false, allowedStatuses: SAFE_STOP_SET },
  { command: 'SHUTDOWN', category: 'DEVICE', highRisk: true, allowedStatuses: SAFE_STOP_SET },
  { command: 'FACTORY_RESET', category: 'DEVICE', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  { command: 'TAKE_SNAPSHOT', category: 'DEVICE', highRisk: false, allowedStatuses: SAFE_STOP_SET },
  { command: 'FORCE_SYNC', category: 'DEVICE', highRisk: false, allowedStatuses: SAFE_STOP_SET },
] as const;

export const COMMAND_CATALOG_VERSION = '1.0.1' as const;

export function getCommandSpec(command: string): CommandSpec | null {
  return COMMAND_CATALOG.find((c) => c.command === command) ?? null;
}

export function assertKnownCommand(command: string): CommandSpec {
  const spec = getCommandSpec(command);
  if (!spec) {
    throw new CommandError('VALIDATION_FAILED', `Unknown command: ${command}`);
  }
  return spec;
}

// ---------- 设备状态门（Suspended/Retired 限制） ----------

/**
 * 门控状态解析：云端权威优先——
 * - lifecycleStatus = Retired → RETIRED（拒绝全部命令）；
 * - lifecycleStatus = Suspended → SUSPENDED（即使设备最近上报仍为 Active，以云端 suspension 为准）；
 * - 否则取设备最近上报 Operational 状态（Active/Maintenance），无上报 → ACTIVE。
 */
export function resolveCommandGateStatus(lifecycleStatus: string, operationalStatus: string | null): CommandGateStatus {
  if (lifecycleStatus === 'Retired') return 'RETIRED';
  if (lifecycleStatus === 'Suspended') return 'SUSPENDED';
  if (operationalStatus === 'Maintenance') return 'MAINTENANCE';
  if (operationalStatus === 'Suspended') return 'SUSPENDED';
  return 'ACTIVE';
}

/** 目录 allowedStatuses 门控：不允许 → DEVICE_STATE_NOT_ALLOWED（409）。 */
export function assertCommandAllowed(spec: CommandSpec, gateStatus: CommandGateStatus): void {
  if (!spec.allowedStatuses.includes(gateStatus)) {
    throw new CommandError(
      'DEVICE_STATE_NOT_ALLOWED',
      `Command ${spec.command} is not allowed while device gate status is ${gateStatus}`,
    );
  }
}

// ---------- 参数与 timeoutSec 校验 ----------

/** timeoutSec 下限（cmd.schema.json：integer minimum 1）。 */
export const COMMAND_TIMEOUT_MIN_SEC = 1 as const;
/** timeoutSec 上限（暂定值：实施方案要求高风险命令有超时策略；决策冻结前按 3600s）。 */
export const COMMAND_TIMEOUT_MAX_SEC = 3600 as const;
/** remarks 最大长度（暂定值）。 */
export const COMMAND_REMARKS_MAX_LENGTH = 500 as const;

export function assertCommandParams(command: string, timeoutSec: unknown, remarks: unknown): number {
  if (typeof timeoutSec !== 'number' || !Number.isInteger(timeoutSec)) {
    throw new CommandError('VALIDATION_FAILED', 'timeoutSec must be an integer');
  }
  if (timeoutSec < COMMAND_TIMEOUT_MIN_SEC || timeoutSec > COMMAND_TIMEOUT_MAX_SEC) {
    throw new CommandError(
      'VALIDATION_FAILED',
      `timeoutSec must be between ${COMMAND_TIMEOUT_MIN_SEC} and ${COMMAND_TIMEOUT_MAX_SEC}`,
    );
  }
  if (remarks !== undefined && remarks !== null) {
    if (typeof remarks !== 'string' || remarks.length > COMMAND_REMARKS_MAX_LENGTH) {
      throw new CommandError(
        'VALIDATION_FAILED',
        `remarks must be a string of at most ${COMMAND_REMARKS_MAX_LENGTH} characters`,
      );
    }
  }
  void command;
  return timeoutSec;
}

// ---------- 高风险命令确认凭证 ----------

/**
 * 确认凭证有效期（暂定值，300s；确认时点距请求过远视为"过期确认"）。
 * 确认凭证语义（V1 模块级约定，DEC 未冻结）：请求体 confirmation = { confirmText, confirmedAt }，
 * confirmText 必须与命令名完全一致（防误确认），confirmedAt 必须在 TTL 内且不允许明显未来时间。
 */
export const COMMAND_CONFIRMATION_TTL_MS = 300_000 as const;
/** confirmedAt 允许的最大未来漂移（时钟偏差，暂定 60s）。 */
export const COMMAND_CONFIRMATION_MAX_FUTURE_MS = 60_000 as const;

export interface CommandConfirmation {
  readonly confirmText: string;
  readonly confirmedAt: string;
}

export function assertHighRiskConfirmation(
  spec: CommandSpec,
  confirmation: CommandConfirmation | undefined,
  now: Date,
): void {
  if (!spec.highRisk) return;
  if (!confirmation) {
    throw new CommandError('VALIDATION_FAILED', `High-risk command ${spec.command} requires a confirmation credential`);
  }
  if (confirmation.confirmText !== spec.command) {
    throw new CommandError('VALIDATION_FAILED', `confirmText must exactly match the command name (${spec.command})`);
  }
  const confirmedAtMs = Date.parse(confirmation.confirmedAt);
  if (Number.isNaN(confirmedAtMs)) {
    throw new CommandError('VALIDATION_FAILED', 'confirmation.confirmedAt must be a valid ISO 8601 timestamp');
  }
  const nowMs = now.getTime();
  if (confirmedAtMs > nowMs + COMMAND_CONFIRMATION_MAX_FUTURE_MS) {
    throw new CommandError('VALIDATION_FAILED', 'confirmation.confirmedAt is in the future');
  }
  if (nowMs - confirmedAtMs > COMMAND_CONFIRMATION_TTL_MS) {
    throw new CommandError('VALIDATION_FAILED', 'Confirmation credential has expired');
  }
}
