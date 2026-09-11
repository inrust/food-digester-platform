/** FE-02 UTC/本地时间显示与用户时区偏好。FE-19：日期按所选语言区域格式化（时间仍按用户时区）。 */

import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { localeForLanguage, useI18n } from '../i18n/i18n.js';

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const SUPPORTED_TIME_ZONES = ['UTC', 'Asia/Shanghai', 'Europe/London', 'America/New_York'] as const;
const TIME_ZONE_KEY = 'fdp.admin.time-zone.v1';

export function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface TimeZoneValue {
  readonly timeZone: string;
  readonly setTimeZone: (value: string) => void;
}

const TimeZoneContext = createContext<TimeZoneValue>({ timeZone: DEFAULT_TIME_ZONE, setTimeZone: () => undefined });

export function TimeZoneProvider({ children }: { readonly children: ReactNode }) {
  const [timeZone, setTimeZoneState] = useState(() => {
    const stored = window.localStorage.getItem(TIME_ZONE_KEY);
    return stored !== null && isSupportedTimeZone(stored) ? stored : DEFAULT_TIME_ZONE;
  });
  const setTimeZone = (value: string) => {
    if (!isSupportedTimeZone(value)) return;
    window.localStorage.setItem(TIME_ZONE_KEY, value);
    setTimeZoneState(value);
  };
  return <TimeZoneContext.Provider value={{ timeZone, setTimeZone }}>{children}</TimeZoneContext.Provider>;
}

export function useUserTimeZone(): TimeZoneValue {
  return useContext(TimeZoneContext);
}

/** ISO(UTC) → 指定时区可读格式；非法输入/时区回退安全值；locale 控制日期区域格式。 */
export function formatInTimeZone(iso: string, timeZone: string = DEFAULT_TIME_ZONE, locale: string = 'zh-CN'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat(locale, { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export interface TimeTextProps {
  readonly iso: string;
  readonly timeZone?: string;
}

export function TimeText({ iso, timeZone: explicitTimeZone }: TimeTextProps) {
  const { timeZone: userTimeZone } = useUserTimeZone();
  const { language } = useI18n();
  const timeZone = explicitTimeZone ?? userTimeZone;
  const date = new Date(iso);
  const valid = !Number.isNaN(date.getTime());
  return (
    <time dateTime={valid ? date.toISOString() : undefined} title={valid ? `UTC：${date.toISOString()}` : undefined}>
      {formatInTimeZone(iso, timeZone, localeForLanguage(language))}
    </time>
  );
}
