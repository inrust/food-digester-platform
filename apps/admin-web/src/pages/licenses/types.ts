/**
 * FE-08 License/Entitlement 数据类型：镜像 admin-license-api.json（BE-LIC-01）。
 */

export type LicenseStatus = 'Draft' | 'Issued' | 'Active' | 'ExpiringSoon' | 'Renewed' | 'Expired' | 'Revoked';

export type EntitlementCode = 'REMOTE_CONTROL' | 'OTA' | 'ESG_REPORTING';

export interface LicenseEntitlementView {
  readonly code: EntitlementCode;
  readonly enabled: boolean;
}

export interface LicenseView {
  readonly licenseId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly status: LicenseStatus;
  /** YYYY-MM-DD（UTC 日期）。 */
  readonly validFrom: string;
  readonly validTo: string;
  readonly entitlements: readonly LicenseEntitlementView[];
  /** 供 Device Sync 下发的签名；Draft 为 null。 */
  readonly signature: string | null;
  readonly version: number;
  /** 查询时点派生（DOM-02 isLicenseEffective）。 */
  readonly effective: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LicenseHistoryEntryView {
  readonly historyId: string;
  readonly fromStatus: LicenseStatus | null;
  readonly toStatus: LicenseStatus;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface LicenseRenewResultView extends LicenseView {
  /** 同目标重复请求幂等回放。 */
  readonly replayed: boolean;
}
