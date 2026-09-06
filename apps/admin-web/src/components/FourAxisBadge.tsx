/**
 * FE-02 四轴状态徽标（DEC-010：connectivity/lifecycle/operational/license 分离展示）。
 * 未知或缺失值显示“—”，不伪造状态；值域与 @fdp/domain / DEC-010 冻结策略对齐。
 */

const CONNECTIVITY_LABELS: Readonly<Record<string, string>> = {
  ONLINE: '在线',
  OFFLINE: '离线',
};

const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  PendingOnboarding: '待录入',
  Rejected: '已拒绝',
  OnboardingApproved: '已审批',
  Onboarded: '已注册',
  Assigned: '已分配',
  Licensed: '已授权',
  Active: '已激活',
  Suspended: '已停用',
  Retired: '已退役',
};

const OPERATIONAL_LABELS: Readonly<Record<string, string>> = {
  Active: '运行',
  Maintenance: '维护',
  Suspended: '暂停',
  Retired: '退役',
};

const LICENSE_LABELS: Readonly<Record<string, string>> = {
  NoLicense: '无授权',
  Draft: '草稿',
  Issued: '已签发',
  Active: '授权有效',
  ExpiringSoon: '即将到期',
  Renewed: '已续期',
  Expired: '已到期',
  Revoked: '已撤销',
};

export type StatusAxis = 'connectivity' | 'lifecycle' | 'operational' | 'license';

export const AXIS_LABELS: Readonly<Record<StatusAxis, string>> = {
  connectivity: '连接',
  lifecycle: '生命周期',
  operational: '运行',
  license: '授权',
};

const AXIS_VALUE_LABELS: Readonly<Record<StatusAxis, Readonly<Record<string, string>>>> = {
  connectivity: CONNECTIVITY_LABELS,
  lifecycle: LIFECYCLE_LABELS,
  operational: OPERATIONAL_LABELS,
  license: LICENSE_LABELS,
};

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
