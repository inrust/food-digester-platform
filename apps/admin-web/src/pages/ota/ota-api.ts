/**
 * FE-13 OTA API 装配（BE-OTA-01 固件包、BE-OTA-02 Campaign）。
 *
 * - createFirmwareUpload：声明元数据 + 签名，返回短期预签名上传 URL（900s 暂定）；
 *   浏览器直传 S3 由容器装配（页面不持密钥/不生成 URL）；
 * - completeFirmwareUpload：对象/大小/SHA-256/签名/病毒扫描全过 → VERIFIED 不可变；
 * - createOtaCampaign：首批强制恰好 1 台（装配层本地守卫 + 服务端 400 兜底）；
 *   包必须 VERIFIED（坏包/未校验包不可建 Campaign）；
 * - expandOtaCampaignBatch：普通批次最多 500 台；最终覆盖全部合格设备时传递 SuperAdmin 显式审批；
 * - pause/resume/cancel/retry 幂等回放；暂停/取消后不得产生新下发（BE-OTA-03 下发器只消费 RUNNING 的 PENDING）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  FirmwarePackageStatus,
  FirmwarePackageType,
  FirmwarePackageView,
  FirmwareUploadSessionCreate,
  FirmwareUploadSessionView,
  OtaBatchExpandResult,
  OtaCampaignDetailView,
  OtaCampaignStatus,
  OtaCampaignView,
  OtaRetryResult,
  OtaTargetStatus,
  OtaTargetView,
} from './types.js';

export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

function buildQuery(filter: Record<string, string | null | undefined>, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  if (cursor !== undefined && cursor !== '') params.set('cursor', cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

// ---------- Firmware Package（BE-OTA-01） ----------

export async function createFirmwareUpload(
  api: ApiClient,
  input: FirmwareUploadSessionCreate,
): Promise<FirmwareUploadSessionView> {
  const response = await api.request<{ data: FirmwareUploadSessionView }>('/admin/ota/packages/upload-sessions', {
    method: 'POST',
    body: input,
  });
  return response.data;
}

export async function completeFirmwareUpload(api: ApiClient, packageId: string): Promise<FirmwarePackageView> {
  const response = await api.request<{ data: FirmwarePackageView }>(
    `/admin/ota/packages/${encodeURIComponent(packageId)}/complete`,
    { method: 'POST' },
  );
  return response.data;
}

export interface PackageListFilter {
  readonly model?: string | null;
  readonly version?: string | null;
  readonly packageType?: FirmwarePackageType | null;
  readonly status?: FirmwarePackageStatus | null;
}

export async function listFirmwarePackages(
  api: ApiClient,
  filter: PackageListFilter,
  cursor?: string,
): Promise<Page<FirmwarePackageView>> {
  const response = await api.request<{ data: FirmwarePackageView[]; meta: { nextCursor: string | null } }>(
    `/admin/ota/packages${buildQuery({ ...filter }, cursor)}`,
  );
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

export async function getFirmwarePackage(api: ApiClient, packageId: string): Promise<FirmwarePackageView> {
  const response = await api.request<{ data: FirmwarePackageView }>(
    `/admin/ota/packages/${encodeURIComponent(packageId)}`,
  );
  return response.data;
}

// ---------- OTA Campaign（BE-OTA-02） ----------

export interface OtaCampaignCreateInput {
  readonly name: string;
  /** 必须为 VERIFIED 包（坏包/未校验包不可建 Campaign）。 */
  readonly packageId: string;
  /** 首批强制恰好 1 台（灰度）；装配层本地守卫，服务端 400 兜底。 */
  readonly deviceIds: readonly string[];
}

export async function createOtaCampaign(api: ApiClient, input: OtaCampaignCreateInput): Promise<OtaCampaignView> {
  // 前端阻止：首批必须恰好 1 台（验收基准；服务端 VALIDATION_FAILED 兜底）
  if (input.deviceIds.length !== 1) {
    throw new Error('首批灰度必须恰好 1 台设备');
  }
  const response = await api.request<{ data: OtaCampaignView }>('/admin/ota/campaigns', {
    method: 'POST',
    body: { name: input.name, packageId: input.packageId, deviceIds: [...input.deviceIds] },
  });
  return response.data;
}

export interface CampaignListFilter {
  readonly status?: OtaCampaignStatus | null;
  readonly targetModel?: string | null;
  readonly packageId?: string | null;
}

export async function listOtaCampaigns(
  api: ApiClient,
  filter: CampaignListFilter,
  cursor?: string,
): Promise<Page<OtaCampaignView>> {
  const response = await api.request<{ data: OtaCampaignView[]; meta: { nextCursor: string | null } }>(
    `/admin/ota/campaigns${buildQuery({ ...filter }, cursor)}`,
  );
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

export async function getOtaCampaign(api: ApiClient, campaignId: string): Promise<OtaCampaignDetailView> {
  const response = await api.request<{ data: OtaCampaignDetailView }>(
    `/admin/ota/campaigns/${encodeURIComponent(campaignId)}`,
  );
  return response.data;
}

export interface TargetListFilter {
  readonly status?: OtaTargetStatus | null;
  readonly batchNo?: number | null;
}

export async function listOtaTargets(
  api: ApiClient,
  campaignId: string,
  filter: TargetListFilter,
  cursor?: string,
): Promise<Page<OtaTargetView>> {
  const response = await api.request<{ data: OtaTargetView[]; meta: { nextCursor: string | null } }>(
    `/admin/ota/campaigns/${encodeURIComponent(campaignId)}/targets${buildQuery(
      { status: filter.status ?? null, batchNo: filter.batchNo != null ? String(filter.batchNo) : null },
      cursor,
    )}`,
  );
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

export async function expandOtaCampaignBatch(
  api: ApiClient,
  campaignId: string,
  deviceIds: readonly string[],
  finalRolloutApproval?: { readonly confirmText: string },
): Promise<OtaBatchExpandResult> {
  if (deviceIds.length < 1 || deviceIds.length > 500) {
    throw new Error('批次设备数须为 1~500 台');
  }
  const response = await api.request<{ data: OtaBatchExpandResult }>(
    `/admin/ota/campaigns/${encodeURIComponent(campaignId)}/batches`,
    {
      method: 'POST',
      body: {
        deviceIds: [...deviceIds],
        ...(finalRolloutApproval !== undefined ? { finalRolloutApproval } : {}),
      },
    },
  );
  return response.data;
}

async function transitionCampaign(
  api: ApiClient,
  campaignId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<OtaCampaignView> {
  const response = await api.request<{ data: OtaCampaignView }>(
    `/admin/ota/campaigns/${encodeURIComponent(campaignId)}/${action}`,
    { method: 'POST' },
  );
  return response.data;
}

export function pauseOtaCampaign(api: ApiClient, campaignId: string): Promise<OtaCampaignView> {
  return transitionCampaign(api, campaignId, 'pause');
}

export function resumeOtaCampaign(api: ApiClient, campaignId: string): Promise<OtaCampaignView> {
  return transitionCampaign(api, campaignId, 'resume');
}

export function cancelOtaCampaign(api: ApiClient, campaignId: string): Promise<OtaCampaignView> {
  return transitionCampaign(api, campaignId, 'cancel');
}

export async function retryOtaCampaignFailures(
  api: ApiClient,
  campaignId: string,
  targetIds?: readonly string[],
): Promise<OtaRetryResult> {
  const response = await api.request<{ data: OtaRetryResult }>(
    `/admin/ota/campaigns/${encodeURIComponent(campaignId)}/retry`,
    {
      method: 'POST',
      ...(targetIds !== undefined && targetIds.length > 0 ? { body: { targetIds: [...targetIds] } } : {}),
    },
  );
  return response.data;
}
