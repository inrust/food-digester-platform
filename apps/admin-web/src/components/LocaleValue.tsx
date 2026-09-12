/** FE-19 统一数字、百分比与单位格式；协议枚举和业务文本不得经此转换。 */
import { localeForLanguage, useI18n } from '../i18n/i18n.js';
import type { Language } from '../i18n/i18n.js';

export function formatLocaleNumber(value: number, language: Language): string {
  return new Intl.NumberFormat(localeForLanguage(language), { maximumFractionDigits: 3 }).format(value);
}

export function formatLocalePercent(value: number, language: Language): string {
  return new Intl.NumberFormat(localeForLanguage(language), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value / 100);
}

const UNIT_NAMES: Readonly<Record<string, Intl.NumberFormatOptions['unit']>> = {
  kg: 'kilogram',
  kWh: 'kilowatt-hour',
  kW: 'kilowatt',
  '°C': 'celsius',
};

export function formatLocaleUnit(value: number, unit: string, language: Language): string {
  const locale = localeForLanguage(language);
  const intlUnit = UNIT_NAMES[unit];
  if (intlUnit !== undefined) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: intlUnit,
        unitDisplay: 'long',
        maximumFractionDigits: 3,
      }).format(value);
    } catch {
      // Runtime does not necessarily support every ECMA-402 unit; preserve the protocol unit on fallback.
    }
  }
  return `${formatLocaleNumber(value, language)} ${unit}`;
}

export function NumberText({ value }: { readonly value: number }) {
  const { language } = useI18n();
  return <>{formatLocaleNumber(value, language)}</>;
}

export function PercentText({ value }: { readonly value: number }) {
  const { language } = useI18n();
  return <>{formatLocalePercent(value, language)}</>;
}

export function UnitValueText({ value, unit }: { readonly value: number; readonly unit: string }) {
  const { language } = useI18n();
  return <>{formatLocaleUnit(value, unit, language)}</>;
}
