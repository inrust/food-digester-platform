import { translate } from '../../i18n/i18n.js';
import type { Language } from '../../i18n/i18n.js';
import { formatLocaleNumber } from '../../components/LocaleValue.js';
/**
 * FE-03 总览页纯逻辑：快捷命令模型、耗材展示模型、授权分布与告警文案。
 *
 * 事实源：
 * - 命令白名单/高风险：contracts/mqtt/command-catalog.json（CT-04，卡片快捷动作 START/STOP/REBOOT）；
 * - 耗材名称/阈值：contracts/domain/consumables-policy.json（DEC-008 冻结）；
 * - denyReason 枚举：contracts/rest/admin-dashboard-api.json（BE-DASH-01）。
 * 一致性由 test/contract-parity.test.ts 锁定。
 */
import type { AlarmSeverity, CommandActionView, ConsumableSummaryView, DenyReason } from './types.js';
// ---------- 快捷命令（CT-06 dashboard.button.start/stop/reboot → CT-04 命令码） ----------
export const QUICK_COMMANDS = [
  {
    command: 'START',
    get label() {
      return translate('ui.ebd26da42171');
    },
  },
  {
    command: 'STOP',
    get label() {
      return translate('ui.a17f70a8d3d6');
    },
  },
  {
    command: 'REBOOT',
    get label() {
      return translate('ui.385c272e35c6');
    },
  },
] as const;
export const DENY_REASON_LABELS: Readonly<Record<DenyReason, string>> = {
  get FORBIDDEN() {
    return translate('ui.9f0832fec43c');
  },
  get UNKNOWN_COMMAND() {
    return translate('ui.1a278a94dec5');
  },
  get DEVICE_RETIRED() {
    return translate('ui.d42f67b500bf');
  },
  get DEVICE_SUSPENDED_RESTRICTED() {
    return translate('ui.a54d4d109215');
  },
  get DEVICE_MAINTENANCE_RESTRICTED() {
    return translate('ui.e0b1c615bf89');
  },
  get DEVICE_OFFLINE() {
    return translate('ui.faffc0e832d2');
  },
};
export interface QuickActionModel {
  readonly command: string;
  readonly label: string;
  readonly allowed: boolean;
  readonly denyReason: DenyReason | null;
}
/** 从卡片 actions（服务端状态门 + 权限）解析快捷动作；目录缺失按 UNKNOWN_COMMAND 失败关闭。 */
export function quickActionsOf(actions: readonly CommandActionView[]): QuickActionModel[] {
  return QUICK_COMMANDS.map(({ command, label }) => {
    const found = actions.find((a) => a.command === command);
    if (found === undefined) {
      return { command, label, allowed: false, denyReason: 'UNKNOWN_COMMAND' };
    }
    return { command, label, allowed: found.allowed, denyReason: found.denyReason };
  });
}
// ---------- 耗材（DEC-008：仅设备上报值；unknown 不伪造百分比；阈值冻结） ----------
export const CONSUMABLE_NAMES: Readonly<Record<ConsumableSummaryView['consumableType'], string>> = {
  get CARBON_FILTER() {
    return translate('ui.caaa5d48413a');
  },
  get BIO_ADDITIVE() {
    return translate('ui.e9567777e70d');
  },
};
/** DEC-008 冻结告警阈值（%）：低于该值按 warn 展示。 */
export const CONSUMABLE_THRESHOLDS: Readonly<Record<ConsumableSummaryView['consumableType'], number>> = {
  CARBON_FILTER: 20,
  BIO_ADDITIVE: 15,
};
export interface ConsumableDisplayModel {
  readonly consumableType: ConsumableSummaryView['consumableType'];
  readonly name: string;
  readonly percent: number | null;
  readonly stale: boolean;
  readonly low: boolean;
}
/** 固定顺序输出两类耗材；缺失类型按 unknown（percent null）处理。 */
export function consumablesOf(list: readonly ConsumableSummaryView[]): ConsumableDisplayModel[] {
  return (['CARBON_FILTER', 'BIO_ADDITIVE'] as const).map((type) => {
    const found = list.find((c) => c.consumableType === type);
    const percent = found?.remainingPercent ?? null;
    return {
      consumableType: type,
      name: CONSUMABLE_NAMES[type],
      percent,
      stale: found?.stale ?? false,
      low: percent !== null && percent < CONSUMABLE_THRESHOLDS[type],
    };
  });
}
// ---------- 指标文案 ----------
export const ALARM_SEVERITY_LABELS: Readonly<Record<AlarmSeverity, string>> = {
  get INFO() {
    return translate('ui.ab3656a956f5');
  },
  get WARNING() {
    return translate('ui.5521e368d87e');
  },
  get MAJOR() {
    return translate('ui.81ffc6f5a47f');
  },
  get CRITICAL() {
    return translate('ui.27429f465b3c');
  },
};
/** License 轴展示名（与 FE-02 四轴徽标同源取值）。 */
const LICENSE_AXIS_LABELS: Readonly<Record<string, string>> = {
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
  get NONE() {
    return translate('ui.deb9e0b029c4');
  },
};
/** 授权分布：按 key 排序拼接；空分布返回“—”。 */
export function licenseDistributionText(
  distribution: Readonly<Record<string, number>>,
  language: Language = 'zh-CN',
): string {
  const entries = Object.entries(distribution).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '—';
  return entries
    .map(([status, count]) => `${LICENSE_AXIS_LABELS[status] ?? status} ${formatLocaleNumber(count, language)}`)
    .join(' · ');
}
/** 连接质量：网络类型 + 信号强度原始值（未冻结强弱阈值，不臆造分级）。 */
export function signalText(
  networkType: string | null,
  signalStrength: number | null,
  language: Language = 'zh-CN',
): string {
  const network = networkType ?? '—';
  const strength = signalStrength === null ? '—' : formatLocaleNumber(signalStrength, language);
  return network + (' ' + translate('page.494fc2b1f3b7') + ' ') + strength;
}
