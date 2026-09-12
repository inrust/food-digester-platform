import { translate } from '../i18n/i18n.js';
/**
 * FE-02 四轴状态徽标（DEC-010：connectivity/lifecycle/operational/license 分离展示）。
 * 未知或缺失值显示“—”，不伪造状态；值域与 @fdp/domain / DEC-010 冻结策略对齐。
 */
const CONNECTIVITY_LABELS: Readonly<Record<string, string>> = {
  get ONLINE() {
    return translate('page.0373ff923114');
  },
  get OFFLINE() {
    return translate('page.211357d22f4d');
  },
};
const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  get PendingOnboarding() {
    return translate('ui.eb87bec8caf6');
  },
  get Rejected() {
    return translate('ui.4c7c52c70655');
  },
  get OnboardingApproved() {
    return translate('ui.f6ced0fcd0e4');
  },
  get Onboarded() {
    return translate('ui.95e31fb7d2e3');
  },
  get Assigned() {
    return translate('ui.e2d4d60f5c07');
  },
  get Licensed() {
    return translate('ui.284cc0bae14b');
  },
  get Active() {
    return translate('ui.b1eea7b855e6');
  },
  get Suspended() {
    return translate('page.6c7dcbb73a59');
  },
  get Retired() {
    return translate('ui.0c9e069eb0b6');
  },
};
const OPERATIONAL_LABELS: Readonly<Record<string, string>> = {
  get Active() {
    return translate('ui.0c3acd446f19');
  },
  get Maintenance() {
    return translate('ui.72527e2f0e5e');
  },
  get Suspended() {
    return translate('ui.130448bce675');
  },
  get Retired() {
    return translate('page.a3a128e21ebb');
  },
};
const LICENSE_LABELS: Readonly<Record<string, string>> = {
  get NoLicense() {
    return translate('page.4a5b140af3a0');
  },
  get Draft() {
    return translate('ui.0f436818c0b4');
  },
  get Issued() {
    return translate('ui.e54802e82b5d');
  },
  get Active() {
    return translate('ui.61f56cfb99e7');
  },
  get ExpiringSoon() {
    return translate('ui.810ab25a9cc8');
  },
  get Renewed() {
    return translate('ui.70e418046725');
  },
  get Expired() {
    return translate('ui.75e6c9fb6feb');
  },
  get Revoked() {
    return translate('ui.61063ba81b3c');
  },
};
export type StatusAxis = 'connectivity' | 'lifecycle' | 'operational' | 'license';
export const AXIS_LABELS: Readonly<Record<StatusAxis, string>> = {
  get connectivity() {
    return translate('page.7328deebb5bc');
  },
  get lifecycle() {
    return translate('page.009200773b02');
  },
  get operational() {
    return translate('ui.0c3acd446f19');
  },
  get license() {
    return translate('ui.3a6e607f0c8d');
  },
};
const AXIS_VALUE_LABELS: Readonly<Record<StatusAxis, Readonly<Record<string, string>>>> = {
  connectivity: CONNECTIVITY_LABELS,
  lifecycle: LIFECYCLE_LABELS,
  operational: OPERATIONAL_LABELS,
  license: LICENSE_LABELS,
};
/** 轴值展示名（筛选项等复用）。 */
export function axisValueLabel(axis: StatusAxis, value: string): string {
  return AXIS_VALUE_LABELS[axis][value] ?? value;
}
/** 轴值 → 展示名映射表（FE-06 筛选项复用）。 */
export const AXIS_VALUE_LABEL_MAPS = AXIS_VALUE_LABELS;
/** 单轴徽标：未知/空值显示“—”。 */
export function AxisBadge({ axis, value }: { axis: StatusAxis; value: string | null | undefined }) {
  const label = value !== null && value !== undefined ? AXIS_VALUE_LABELS[axis][value] : undefined;
  return (
    <span className={`axis-badge axis-${axis}`} data-axis={axis} data-value={value ?? 'unknown'}>
      {AXIS_LABELS[axis]}：{label ?? '—'}
    </span>
  );
}
export interface FourAxisStatusValue {
  readonly connectivity: string | null;
  readonly lifecycle: string | null;
  readonly operational: string | null;
  readonly license: string | null;
}
/** 四轴状态徽标组（DEC-010：禁止单字段混用，四轴并列展示）。 */
export function FourAxisBadges({ status }: { status: FourAxisStatusValue }) {
  return (
    <span className="four-axis-badges" data-testid="four-axis-badges">
      <AxisBadge axis="connectivity" value={status.connectivity} />
      <AxisBadge axis="lifecycle" value={status.lifecycle} />
      <AxisBadge axis="operational" value={status.operational} />
      <AxisBadge axis="license" value={status.license} />
    </span>
  );
}
