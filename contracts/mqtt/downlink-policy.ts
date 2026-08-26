/**
 * DEC-006 下行消息 meta.seq 与幂等键策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/mqtt/downlink-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-006@0.2.0（status=pending，暂定值已可执行，冻结后仅改状态或按
 * migration.onFrozenChange 演进契约）。
 *
 * 消费方：CT-03、BE-CMD-02（幂等）、BE-CMD-01、BE-IOT-02。
 */

export type DownlinkPolicyStatus = 'provisional' | 'frozen';

export type MetaSeqRequirement = 'optional' | 'required';

export interface DownlinkPolicy {
  readonly policyVersion: string;
  readonly status: DownlinkPolicyStatus;
  readonly sequencing: {
    readonly downlinkMetaSeq: MetaSeqRequirement;
    readonly uplinkMetaSeq: 'required';
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly idempotency: {
    readonly commandKey: 'meta.id';
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly migration: {
    readonly onFrozenChange: 'additive-contract-change';
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-006 v0.2.0，pending）：
 * V1 下行不强制 meta.seq；Command 以 meta.id 幂等。
 */
export const DOWNLINK_POLICY: DownlinkPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  sequencing: {
    downlinkMetaSeq: 'optional',
    uplinkMetaSeq: 'required',
    consumers: ['CT-03', 'BE-IOT-02'],
    note: 'V1：下行（cmd/notification/ota）meta.seq 可选，发送方与设备均不得依赖其存在；上行（telemetry/report/tamper/alarm/event/ack/media/heartbeat）meta.seq 必填（common.schema.json metaSeq）。',
  },
  idempotency: {
    commandKey: 'meta.id',
    consumers: ['CT-03', 'BE-CMD-02', 'BE-CMD-01'],
    note: 'Command 幂等键为 meta.id（common.schema.json metaBase 必填）。BE-CMD-02 状态机与去重必须以 meta.id 为基准，不得使用 seq 或 Payload 内容派生幂等键。',
  },
  migration: {
    onFrozenChange: 'additive-contract-change',
    consumers: ['CT-03'],
    note: '若冻结值改为强制下行 seq：属可选→必填的契约变更，需提升 common.schema.json 主版本并同步全部下行 Schema；policyVersion 同步升级。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    'DEC-006 冻结时：按 decision-change-template 变更 DEC-006 至 >=1.0.0，status 改 frozen；暂定值未变化则仅改状态，若变化按 migration.onFrozenChange 执行契约演进。',
} as const;

/** 下行 meta.seq 是否必填。V1 暂定为 false。 */
export function isDownlinkMetaSeqRequired(): boolean {
  return DOWNLINK_POLICY.sequencing.downlinkMetaSeq === 'required';
}

/** 上行 meta.seq 是否必填：恒为 true（锁定规则）。 */
export function isUplinkMetaSeqRequired(): boolean {
  return DOWNLINK_POLICY.sequencing.uplinkMetaSeq === 'required';
}

/** Command 幂等键：恒为 meta.id（锁定规则）。 */
export function getCommandIdempotencyKey(): 'meta.id' {
  return DOWNLINK_POLICY.idempotency.commandKey;
}

/** 策略当前状态：provisional 表示 DEC-006 未冻结。 */
export function getDownlinkPolicyStatus(): DownlinkPolicyStatus {
  return DOWNLINK_POLICY.status;
}
