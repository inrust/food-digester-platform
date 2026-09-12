/** FE-19 统一数字、百分比与单位格式；协议枚举和业务文本不得经此转换。 */
import { localeForLanguage, useI18n } from '../i18n/i18n.js';
import type { Language } from '../i18n/i18n.js';

type FractionDigits = Pick<Intl.NumberFormatOptions, 'minimumFractionDigits' | 'maximumFractionDigits'>;

export function formatLocaleNumber(
  value: number,
  language: Language,
  digits: FractionDigits = { maximumFractionDigits: 3 },
): string {
  return new Intl.NumberFormat(localeForLanguage(language), digits).format(value);
}

export function formatLocalePercent(
  value: number,
  language: Language,
  digits: FractionDigits = { maximumFractionDigits: 1 },
): string {
  return new Intl.NumberFormat(localeForLanguage(language), {
    style: 'percent',
    ...digits,
  }).format(value / 100);
}

const UNIT_NAMES: Readonly<Record<string, Intl.NumberFormatOptions['unit']>> = {
  kg: 'kilogram',
  kWh: 'kilowatt-hour',
  kW: 'kilowatt',
  '°C': 'celsius',
  B: 'byte',
  KB: 'kilobyte',
  s: 'second',
  min: 'minute',
};

export function formatLocaleUnit(
  value: number,
  unit: string,
  language: Language,
  digits: FractionDigits = { maximumFractionDigits: 3 },
): string {
  const locale = localeForLanguage(language);
  const intlUnit = UNIT_NAMES[unit];
  if (intlUnit !== undefined) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: intlUnit,
        unitDisplay: 'long',
        ...digits,
      }).format(value);
    } catch {
      // Runtime does not necessarily support every ECMA-402 unit; preserve the protocol unit on fallback.
    }
  }
  return `${formatLocaleNumber(value, language, digits)} ${unit}`;
}

export function NumberText({ value, digits }: { readonly value: number; readonly digits?: FractionDigits }) {
  const { language } = useI18n();
  return <>{formatLocaleNumber(value, language, digits)}</>;
}

export function PercentText({ value, digits }: { readonly value: number; readonly digits?: FractionDigits }) {
  const { language } = useI18n();
  return <>{formatLocalePercent(value, language, digits)}</>;
}

export function UnitValueText({
  value,
  unit,
  digits,
}: {
  readonly value: number;
  readonly unit: string;
  readonly digits?: FractionDigits;
}) {
  const { language } = useI18n();
  return <>{formatLocaleUnit(value, unit, language, digits)}</>;
}
