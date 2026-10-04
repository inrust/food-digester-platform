import { Button } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
/**
 * FE-08 授权摘要（可复用组件）：供授权管理列表与 FE-17 合约详情页嵌入。
 *
 * DEC-007：License 授权状态独立展示，绝不把 Contract 状态直接显示成 License 状态；
 * 无授权（NoLicense）明确展示，不伪造。
 */
import type { DeviceLicenseSummaryView } from '../devices/types.js';
import { ENTITLEMENT_LABELS, licenseStatusLabel } from './license-state.js';
import type { EntitlementCode } from './types.js';
export interface LicenseSummaryProps {
  readonly summary: DeviceLicenseSummaryView | null;
  /** 提供时显示“查看授权”入口（跳转授权详情）。 */
  readonly onOpen?: (licenseId: string) => void;
}
export function LicenseSummary({ summary, onOpen }: LicenseSummaryProps) {
  if (summary === null) {
    return (
      <span className="license-summary empty" data-testid="license-summary">
        {translate('page.4a5b140af3a0')}
      </span>
    );
  }
  const entitlements = summary.entitlements
    .map((code) => ENTITLEMENT_LABELS[code as EntitlementCode] ?? code)
    .join('、');
  return (
    <span className="license-summary" data-testid="license-summary" data-status={summary.status}>
      <span className="license-status" data-testid="license-summary-status">
        {licenseStatusLabel(summary.status)}
      </span>
      <span className="license-validity">
        {summary.validFrom} ~ {summary.validTo}
      </span>
      <span className="license-entitlements">{entitlements === '' ? '—' : entitlements}</span>
      {onOpen !== undefined ? (
        <Button type="button" data-testid="license-summary-open" onClick={() => onOpen(summary.licenseId)}>
          {translate('page.642b717e63c6')}
        </Button>
      ) : null}
    </span>
  );
}
