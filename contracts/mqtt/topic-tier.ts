/**
 * DEC-002 Topic Tier 标记（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/mqtt/topic-tier.json（本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-002@0.2.0（status=pending，本登记为暂定实现，冻结后整体替换）。
 *
 * 消费方：CT-03（MQTT JSON Schema 的 audit 强制字段）、BE-IOT-02（Ingestion 校验管线）。
 * 约束：消费方只能经本模块查询 Tier，禁止直接读取 JSON 字段或复制暂定值；
 * 未知 Topic 一律失败关闭（fallbackPolicy=deny）。
 */

import { isTopicType, type TopicType } from './topics.ts';

export type TierStatus = 'provisional' | 'frozen';

/** AUDITED=信封强制 meta+audit+data（audit.hash 必填）；STANDARD=meta+data，不含 audit。 */
export type TopicTier = 'AUDITED' | 'STANDARD';

export interface TopicTierSpec {
  readonly tier: TopicTier;
  /** 消费该 Tier 条目的任务 ID。 */
  readonly consumers: readonly string[];
  readonly note: string;
}

export interface TopicTierRegistry {
  readonly tierVersion: string;
  readonly status: TierStatus;
  readonly fallbackPolicy: 'deny';
  readonly sourceRule: string;
  readonly topics: Readonly<Record<TopicType, TopicTierSpec>>;
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-002 v0.2.0，pending）：具体 Payload 示例优先；
 * Telemetry/Report/Tamper 含 audit，Command 不含 audit。
 */
export const TOPIC_TIER_REGISTRY: TopicTierRegistry = {
  tierVersion: '0.1.0',
  status: 'provisional',
  fallbackPolicy: 'deny',
  sourceRule:
    '具体 Payload 示例优先：Tier 以《Device-Cloud Communication Design》各类消息的 Payload 示例为事实源，不得由云端臆测添加或删除 audit。',
  topics: {
    heartbeat: { tier: 'STANDARD', consumers: ['CT-03', 'BE-IOT-02'], note: 'Payload 示例无 audit。' },
    telemetry: {
      tier: 'AUDITED',
      consumers: ['CT-03', 'BE-IOT-02'],
      note: '暂定值明确：Telemetry 含 audit；示例信封 meta+audit+data。',
    },
    report: {
      tier: 'AUDITED',
      consumers: ['CT-03', 'BE-IOT-02'],
      note: '暂定值明确：ESG Report 含 audit；保留 audit.hash 与计算方法版本。',
    },
    alarm: { tier: 'STANDARD', consumers: ['CT-03', 'BE-IOT-02'], note: 'Payload 示例无 audit。' },
    event: { tier: 'STANDARD', consumers: ['CT-03', 'BE-IOT-02'], note: 'Payload 示例无 audit。' },
    ack: { tier: 'STANDARD', consumers: ['CT-03', 'BE-IOT-02'], note: 'Payload 示例无 audit。' },
    tamper: {
      tier: 'AUDITED',
      consumers: ['CT-03', 'BE-IOT-02'],
      note: '暂定值明确：Tamper 含 audit；Tamper 使用 audit.hash 防篡改。',
    },
    media: { tier: 'STANDARD', consumers: ['CT-03', 'BE-IOT-02'], note: 'Payload 示例无 audit。' },
    cmd: {
      tier: 'STANDARD',
      consumers: ['CT-03'],
      note: '暂定值明确：Command 不含 audit；下行消息以 meta.id 幂等（DEC-006）。',
    },
    ota: { tier: 'STANDARD', consumers: ['CT-03'], note: '下行 Payload 示例无 audit。' },
    notification: { tier: 'STANDARD', consumers: ['CT-03'], note: '下行 Payload 示例无 audit。' },
  },
  frozenUpgradePath:
    'DEC-002 冻结时：按 decision-change-template 变更 DEC-002 至 >=1.0.0，整体替换本文件并提升 tierVersion；若 Tier 判定变化，需同步更新受影响 Schema 的 required/audit 字段与生成类型。',
} as const;

export class TopicTierError extends Error {
  readonly kind: 'UNKNOWN_TOPIC';

  constructor(kind: TopicTierError['kind'], value: string) {
    super(`${kind}: ${value}`);
    this.name = 'TopicTierError';
    this.kind = kind;
  }
}

export function getTopicTierSpec(topic: string): TopicTierSpec {
  if (!isTopicType(topic)) throw new TopicTierError('UNKNOWN_TOPIC', topic);
  return TOPIC_TIER_REGISTRY.topics[topic];
}

/** Topic 的 Tier。未知 Topic 抛出 TopicTierError（失败关闭）。 */
export function getTopicTier(topic: string): TopicTier {
  return getTopicTierSpec(topic).tier;
}

/** Topic 的 Payload 是否强制携带 audit（含 audit.hash）。BE-IOT-02 校验管线使用。 */
export function topicRequiresAudit(topic: string): boolean {
  return getTopicTier(topic) === 'AUDITED';
}

export function listTopicsByTier(tier: TopicTier): TopicType[] {
  return (Object.keys(TOPIC_TIER_REGISTRY.topics) as TopicType[]).filter(
    (t) => TOPIC_TIER_REGISTRY.topics[t].tier === tier,
  );
}

/** Tier 登记当前状态：provisional 表示 DEC-002 未冻结，消费方不得把值固化为不可迁移结构。 */
export function getTopicTierStatus(): TierStatus {
  return TOPIC_TIER_REGISTRY.status;
}
