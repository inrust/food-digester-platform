/**
 * BE-ALM-01 告警处理领域规则（纯领域，无 IO）。
 *
 * 事实源：alarms 表（BE-IOT-07 写入：设备上报 ACTIVE 插入新行、CLEARED 条件关闭同 code
 * ACTIVE 行）。本模块定义管理端处理（确认/清除）的状态机与严重度封闭集合：
 * - 状态机：ACTIVE → ACKNOWLEDGED → CLEARED；ACTIVE → CLEARED（直接清除）；终态 CLEARED 无出边；
 * - 确认幂等：ACKNOWLEDGED 重复确认由服务层判定为重放（不属迁移，不产生审计/通知）；
 * - 清除幂等：CLEARED 重复清除同理（设备已清除或管理端重复操作）；
 * - 严重度集合与 BE-IOT-07 写入侧一致（INFO | WARNING | MAJOR | CRITICAL）。
 */
export const ALARM_SEVERITIES = ['INFO', 'WARNING', 'MAJOR', 'CRITICAL'] as const;
export type AlarmSeverity = (typeof ALARM_SEVERITIES)[number];

export const ALARM_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'CLEARED'] as const;
export type AlarmStatus = (typeof ALARM_STATUSES)[number];

export class AlarmError extends Error {
  override readonly name = 'AlarmError';
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

/** 管理端处理迁移表：from → 允许的 to 集合。 */
export const ALARM_ADMIN_TRANSITIONS: Readonly<Record<AlarmStatus, readonly AlarmStatus[]>> = {
  ACTIVE: ['ACKNOWLEDGED', 'CLEARED'],
  ACKNOWLEDGED: ['CLEARED'],
  CLEARED: [],
} as const;

/** 状态迁移校验；非法跳转抛 AlarmError(CONFLICT)。 */
export function assertAlarmTransition(from: AlarmStatus, to: AlarmStatus): void {
  if (!(ALARM_ADMIN_TRANSITIONS[from] as readonly string[]).includes(to)) {
    throw new AlarmError('CONFLICT', `The alarm status transition from ${from} to ${to} is not allowed`);
  }
}
