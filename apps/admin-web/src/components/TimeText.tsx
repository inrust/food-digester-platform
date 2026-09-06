/**
 * FE-02 UTC/本地时间显示：数据一律 UTC 存储，按用户选择的时区渲染；title 保留 UTC 原值。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** ISO(UTC) → 指定时区可读格式；非法输入/时区回退安全值。 */
export function formatInTimeZone(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  return new Intl.DateTimeFormat('zh-CN', {
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

export function TimeText({ iso, timeZone = DEFAULT_TIME_ZONE }: TimeTextProps) {
  const date = new Date(iso);
  const valid = !Number.isNaN(date.getTime());
  return (
    <time dateTime={valid ? date.toISOString() : undefined} title={valid ? `UTC：${date.toISOString()}` : undefined}>
      {formatInTimeZone(iso, timeZone)}
    </time>
  );
}
