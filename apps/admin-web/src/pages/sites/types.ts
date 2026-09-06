/**
 * FE-05 Site 数据类型：镜像 contracts/rest/admin-site-api.json（BE-CUS-02，DEC-011）。
 */

export type SiteStatus = 'ACTIVE' | 'SUSPENDED';

export interface SiteView {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  readonly status: SiteStatus;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly address: string | null;
  /** IANA 时区标识（如 Asia/Shanghai）。 */
  readonly timezone: string;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly deviceCount: number;
  /** 乐观锁版本（写操作经 If-Match 携带）。 */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SiteInput {
  readonly name: string;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly address: string | null;
  readonly timezone: string;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
}

export const SITE_STATUS_LABELS: Readonly<Record<SiteStatus, string>> = {
  ACTIVE: '正常',
  SUSPENDED: '已停用',
};
