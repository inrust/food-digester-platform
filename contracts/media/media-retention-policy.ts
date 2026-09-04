/**
 * DEC-005 Media 文件与元数据保留期策略（冻结策略）。
 *
 * 事实源：contracts/media/media-retention-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-005@1.0.0（status=frozen，本策略为冻结实现）。
 *
 * 消费方：BE-MED-01（Media 元数据/上传会话）、FE-14（Media 页面）、
 * BE-ARC-02（S3 归档与 Media Bucket 分离）。
 * 约束：存储分离（RDS 元数据 / S3 文件）可直接执行；保留天数与到期处置是
 * DEC-005@1.0.0 已冻结为元数据 365 天、文件 90 天、文件到期删除但保留元数据。
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
    /** 冻结参数；类型保留 null 仅用于未来 provisional 版本的失败关闭。 */
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
 * DEC-005@1.0.0 冻结值。
 */
export const MEDIA_RETENTION_POLICY: MediaRetentionPolicy = {
  policyVersion: '1.0.0',
  status: 'frozen',
  storageSplit: {
    metadataStore: 'rds',
    fileStore: 's3',
    consumers: ['BE-MED-01', 'BE-ARC-02'],
    note: '元数据（mediaType、objectPath、Hash、observedAt 等）保存于 RDS；媒体文件二进制保存于 S3 独立 Media Bucket。两者禁止互换或合并存储。',
  },
  retention: {
    metadataRetentionDays: 365,
    fileRetentionDays: 90,
    expiryAction: 'delete-file-keep-metadata',
    consumers: ['BE-MED-01', 'FE-14', 'BE-ARC-02'],
    note: 'RDS 元数据保留 365 天；S3 文件保留 90 天。文件到期后删除对象，元数据及完整性 Hash 保留至 365 天到期。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    '保留期或处置行为变化必须提升 DEC-005 与 policyVersion，并同步 S3 生命周期、RDS 清理任务、API 和前端展示。',
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

/** RDS 元数据保留天数；参数缺失时失败关闭。 */
export function getMetadataRetentionDays(): number {
  return requireFrozen(MEDIA_RETENTION_POLICY.retention.metadataRetentionDays, 'retention.metadataRetentionDays');
}

/** S3 文件保留天数；参数缺失时失败关闭。 */
export function getFileRetentionDays(): number {
  return requireFrozen(MEDIA_RETENTION_POLICY.retention.fileRetentionDays, 'retention.fileRetentionDays');
}

/** 到期处置行为；参数缺失时失败关闭。 */
export function getExpiryAction(): ExpiryAction {
  return requireFrozen(MEDIA_RETENTION_POLICY.retention.expiryAction, 'retention.expiryAction');
}

/** 冻结参数齐备时允许自动执行生命周期策略。 */
export function isAutomaticExpiryEnabled(): boolean {
  return (
    MEDIA_RETENTION_POLICY.retention.metadataRetentionDays !== null &&
    MEDIA_RETENTION_POLICY.retention.fileRetentionDays !== null &&
    MEDIA_RETENTION_POLICY.retention.expiryAction !== null
  );
}

/** 策略当前状态：frozen 表示 DEC-005 已冻结，消费方不得把值固化为不可迁移结构。 */
export function getRetentionPolicyStatus(): RetentionPolicyStatus {
  return MEDIA_RETENTION_POLICY.status;
}
