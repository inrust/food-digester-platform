/**
 * BE-ONB-02 管理端 Onboarding 审批 Repository（平台侧显式管理接口）。
 *
 * - 平台跨 Customer 查询 onboarding_requests（无 customerId 维度，设备尚未分配）；
 * - 审批采用条件更新 (id, status='PENDING', version=If-Match) + 版本自增：
 *   并发/重复审批最多一个成功，败方按当前状态区分 CONFLICT（已审批）与
 *   VERSION_CONFLICT（版本不符）；
 * - 响应序列化永不包含 tokenId（Token 关联仅内部使用）。
 */
import type { DbClient } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import { alreadyReviewed, requestNotFound, versionConflict } from './errors.js';

export const ADMIN_ONBOARDING_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'TIMED_OUT'] as const;
export type AdminOnboardingStatus = (typeof ADMIN_ONBOARDING_STATUSES)[number];

export interface AdminOnboardingRequestRecord {
  readonly id: string;
  readonly serialNumber: string;
  readonly csrPem?: string | null;
  readonly publicKeyFingerprint?: string | null;
  readonly submittedBy: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: Date;
  readonly status: string;
  readonly rejectReason: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly provisioningJob?: { readonly status: string } | null;
}

export type CertificateProvisioningStatus =
  'NOT_STARTED' | 'QUEUED' | 'PROCESSING' | 'RETRY' | 'COMPLETED' | 'FAILED' | 'NOT_APPLICABLE';

/** 对外 DTO：不含 tokenId 与任何 Token 关联字段。 */
export interface AdminOnboardingRequestDto {
  readonly requestId: string;
  readonly serialNumber: string;
  readonly publicKeyFingerprint?: string | null;
  readonly submittedBy: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: string;
  readonly status: AdminOnboardingStatus;
  readonly rejectReason: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly certificateProvisioningStatus: CertificateProvisioningStatus;
}

export function toDto(record: AdminOnboardingRequestRecord): AdminOnboardingRequestDto {
  return {
    requestId: record.id,
    serialNumber: record.serialNumber,
    ...(record.publicKeyFingerprint ? { publicKeyFingerprint: record.publicKeyFingerprint } : {}),
    submittedBy: record.submittedBy,
    model: record.model,
    hardwareVersion: record.hardwareVersion,
    manufacturer: record.manufacturer,
    manufactureDate: record.manufactureDate.toISOString().slice(0, 10),
    status: record.status as AdminOnboardingStatus,
    rejectReason: record.rejectReason,
    reviewedBy: record.reviewedBy,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    certificateProvisioningStatus: certificateProvisioningStatus(record),
  };
}

function certificateProvisioningStatus(record: AdminOnboardingRequestRecord): CertificateProvisioningStatus {
  if (record.status === 'PENDING') return 'NOT_STARTED';
  if (record.status === 'REJECTED' || record.status === 'TIMED_OUT') return 'NOT_APPLICABLE';
  const status = record.provisioningJob?.status;
  if (status === 'PROCESSING' || status === 'RETRY' || status === 'COMPLETED' || status === 'FAILED') return status;
  return 'QUEUED';
}

interface AdminOnboardingRequestDelegate {
  findMany(args: Record<string, unknown>): Promise<AdminOnboardingRequestRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<AdminOnboardingRequestRecord | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function requests(client: DbClient): AdminOnboardingRequestDelegate {
  return (client as unknown as Record<string, unknown>).onboardingRequest as AdminOnboardingRequestDelegate;
}

export interface ListReviewQueueArgs {
  readonly status?: AdminOnboardingStatus | undefined;
  readonly cursor?: string | null | undefined;
  readonly limit?: number | string | null | undefined;
}

export interface ReviewQueuePage {
  readonly items: AdminOnboardingRequestRecord[];
  readonly nextCursor: string | null;
}

/** 待审批列表（键集游标，id 升序；status 过滤缺省 PENDING）。 */
export async function listOnboardingRequests(
  client: DbClient,
  args: ListReviewQueueArgs = {},
): Promise<ReviewQueuePage> {
  const limit = normalizeLimit(args.limit);
  const after = decodeKeysetCursor(args.cursor);
  const status = args.status ?? 'PENDING';
  const where: Record<string, unknown> = after ? { status, id: { gt: after } } : { status };
  const rows = await requests(client).findMany({
    where,
    orderBy: { id: 'asc' },
    take: limit + 1,
    include: { provisioningJob: { select: { status: true } } },
  });
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null };
}

export function findOnboardingRequestById(
  client: DbClient,
  requestId: string,
): Promise<AdminOnboardingRequestRecord | null> {
  return requests(client).findFirst({
    where: { id: requestId },
    include: { provisioningJob: { select: { status: true } } },
  });
}

export interface ReviewPatch {
  readonly status: 'APPROVED' | 'REJECTED';
  readonly rejectReason: string | null;
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
}

/**
 * 条件审批更新：仅当申请仍处于 PENDING 且 version 与 If-Match 一致时生效。
 * count=0 时读取当前记录区分语义：不存在 → NOT_FOUND；已审批 → CONFLICT；版本不符 → VERSION_CONFLICT。
 */
export async function reviewOnboardingRequestWithVersion(
  client: DbClient,
  requestId: string,
  expectedVersion: number,
  patch: ReviewPatch,
): Promise<AdminOnboardingRequestRecord> {
  const { count } = await requests(client).updateMany({
    where: { id: requestId, status: 'PENDING', version: expectedVersion },
    data: {
      status: patch.status,
      rejectReason: patch.rejectReason,
      reviewedBy: patch.reviewedBy,
      reviewedAt: patch.reviewedAt,
      version: { increment: 1 },
    },
  });
  if (count === 1) {
    const updated = await findOnboardingRequestById(client, requestId);
    if (!updated) throw requestNotFound();
    return updated;
  }
  const current = await findOnboardingRequestById(client, requestId);
  if (!current) throw requestNotFound();
  if (current.status !== 'PENDING') throw alreadyReviewed();
  throw versionConflict();
}
