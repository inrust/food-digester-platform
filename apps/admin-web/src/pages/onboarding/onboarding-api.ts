/**
 * FE-04 Onboarding 审批 API 装配（BE-ONB-02）。
 * approve/reject 携 If-Match（乐观锁防并发/重复审批）；reject 强制 reason。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { OnboardingRequestView, OnboardingStatus } from './types.js';

interface PageMeta {
  readonly nextCursor: string | null;
}

export interface OnboardingRequestList {
  readonly items: readonly OnboardingRequestView[];
  readonly nextCursor: string | null;
}

export async function fetchOnboardingRequests(
  api: ApiClient,
  options?: { status?: OnboardingStatus; cursor?: string | null; limit?: number },
): Promise<OnboardingRequestList> {
  const params = new URLSearchParams();
  params.set('status', options?.status ?? 'PENDING');
  if (options?.cursor !== undefined && options.cursor !== null) params.set('cursor', options.cursor);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const response = await api.request<{ data: OnboardingRequestView[]; meta: PageMeta }>(
    `/admin/onboarding/requests?${params.toString()}`,
  );
  return { items: response.data, nextCursor: response.meta.nextCursor };
}

export async function fetchOnboardingRequest(api: ApiClient, requestId: string): Promise<OnboardingRequestView> {
  const response = await api.request<{ data: OnboardingRequestView }>(
    `/admin/onboarding/requests/${encodeURIComponent(requestId)}`,
  );
  return response.data;
}

export async function approveOnboardingRequest(
  api: ApiClient,
  requestId: string,
  version: number,
): Promise<OnboardingRequestView> {
  const response = await api.request<{ data: OnboardingRequestView }>(
    `/admin/onboarding/requests/${encodeURIComponent(requestId)}/approve`,
    { method: 'POST', ifMatch: version },
  );
  return response.data;
}

export async function rejectOnboardingRequest(
  api: ApiClient,
  requestId: string,
  version: number,
  reason: string,
): Promise<OnboardingRequestView> {
  const response = await api.request<{ data: OnboardingRequestView }>(
    `/admin/onboarding/requests/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST', ifMatch: version, body: { reason } },
  );
  return response.data;
}
