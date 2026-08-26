/**
 * DEC-005 Media 文件与元数据保留期策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/media/media-retention-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-005@0.2.0（status=pending，本策略为暂定实现，冻结后整体替换）。
 *
 * 消费方：BE-MED-01（Media 元数据/上传会话）、FE-14（Media 页面）、
 * BE-ARC-02（S3 归档与 Media Bucket 分离）。
 * 约束：存储分离（RDS 元数据 / S3 文件）可直接执行；保留天数与到期处置是
 * DEC-005 待冻结内容，读取时失败关闭（抛 PolicyParameterPendingError）。
 */

import { PolicyParameterPendingError } from '../security/certificate-package-policy.ts';

export type RetentionPolicyStatus = 'provisional' | 'frozen';

export type ExpiryAction = 'delete' | 'archive' | 'delete-file-keep-metadata';

export interface MediaRetentionPolicy {
  readonly policyVersion: string;
  readonly status: RetentionPolicyStatus;
  readonly storageSplit: {
    readonly metadataStore: 'rds';
    readonly fileStore: 's3';
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly retention: {
    /** DEC-005 待冻结参数；provisional 为 null。 */
    readonly metadataRetentionDays: number | null;
    readonly fileRetentionDays: number | null;
    readonly expiryAction: ExpiryAction | null;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-005 v0.2.0，pending）：
 * RDS 保存元数据、S3 保存文件；具体期限待定。
 */
export const MEDIA_RETENTION_POLICY: MediaRetentionPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  storageSplit: {
    metadataStore: 'rds',
    fileStore: 's3',
    consumers: ['BE-MED-01', 'BE-ARC-02'],
    note: '元数据（mediaType、objectPath、Hash、observedAt 等）保存于 RDS；媒体文件二进制保存于 S3 独立 Media Bucket。两者禁止互换或合并存储。',
  },
  retention: {
    metadataRetentionDays: null,
    fileRetentionDays: null,
    expiryAction: null,
    consumers: ['BE-MED-01', 'FE-14', 'BE-ARC-02'],
    note: 'DEC-005 待冻结参数：RDS 元数据保留天数、S3 文件保留天数、到期处置行为（expiryAction）。当前均为 null。冻结前：不做任何自动过期/删除，查询接口按现有数据返回，FE-14 不得展示伪造的到期倒计时。',
  },
  pendingParameters: ['retention.metadataRetentionDays', 'retention.fileRetentionDays', 'retention.expiryAction'],
  frozenUpgradePath:
    'DEC-005 冻结时：按 decision-change-template 变更 DEC-005 至 >=1.0.0，填入保留天数与到期处置行为并提升 policyVersion、status 改 frozen；S3 生命周期规则属运维配置，由冻结值驱动，本策略不直接创建。',
} as const;

function requireFrozen<T>(value: T | null, parameter: string): T {
  if (value === null) throw new PolicyParameterPendingError(parameter);
  return value;
}

/** 元数据存储位置：恒为 RDS（锁定规则）。 */
export function getMetadataStore(): 'rds' {
  return MEDIA_RETENTION_POLICY.storageSplit.metadataStore;
}

/** 文件存储位置：恒为 S3（锁定规则）。 */
export function getFileStore(): 's3' {
  return MEDIA_RETENTION_POLICY.storageSplit.fileStore;
}

/** RDS 元数据保留天数。DEC-005 冻结前调用抛 PolicyParameterPendingError。 */
export function getMetadataRetentionDays(): number {
  return requireFrozen(MEDIA_RETENTION_POLICY.retention.metadataRetentionDays, 'retention.metadataRetentionDays');
}

/** S3 文件保留天数。DEC-005 冻结前调用抛 PolicyParameterPendingError。 */
export function getFileRetentionDays(): number {
  return requireFrozen(MEDIA_RETENTION_POLICY.retention.fileRetentionDays, 'retention.fileRetentionDays');
}

/** 到期处置行为。DEC-005 冻结前调用抛 PolicyParameterPendingError。 */
export function getExpiryAction(): ExpiryAction {
  return requireFrozen(MEDIA_RETENTION_POLICY.retention.expiryAction, 'retention.expiryAction');
}

/**
 * 冻结前是否允许自动过期/删除：恒为 false（参数未冻结，禁止任何自动清理）。
 */
export function isAutomaticExpiryEnabled(): boolean {
  return (
    MEDIA_RETENTION_POLICY.retention.metadataRetentionDays !== null &&
    MEDIA_RETENTION_POLICY.retention.fileRetentionDays !== null &&
    MEDIA_RETENTION_POLICY.retention.expiryAction !== null
  );
}

/** 策略当前状态：provisional 表示 DEC-005 未冻结，消费方不得把值固化为不可迁移结构。 */
export function getRetentionPolicyStatus(): RetentionPolicyStatus {
  return MEDIA_RETENTION_POLICY.status;
}
