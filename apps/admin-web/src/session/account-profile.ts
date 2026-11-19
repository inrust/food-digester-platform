import type { ApiClient } from '../api/http-client.js';

export interface OwnAccountProfile {
  readonly userId: string | null;
  readonly displayName: string | null;
}

export async function fetchOwnAccountProfile(api: ApiClient, signal: AbortSignal): Promise<OwnAccountProfile> {
  const { data } = await api.request<{ data: OwnAccountProfile }>('/admin/account/profile', {
    cache: 'no-store',
    signal,
  });
  return data;
}
