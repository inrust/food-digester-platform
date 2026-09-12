/** FE-11/14/15 共用的 IANA 时区输入转换；不依赖浏览器本地时区。 */

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function validParts(parts: LocalParts): boolean {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() + 1 === parts.month &&
    date.getUTCDate() === parts.day &&
    date.getUTCHours() === parts.hour &&
    date.getUTCMinutes() === parts.minute &&
    date.getUTCSeconds() === parts.second
  );
}

function zonedParts(instant: number, timeZone: string): LocalParts | null {
  try {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    return {
      year: values['year'] ?? 0,
      month: values['month'] ?? 0,
      day: values['day'] ?? 0,
      hour: values['hour'] ?? 0,
      minute: values['minute'] ?? 0,
      second: values['second'] ?? 0,
    };
  } catch {
    return null;
  }
}

function sameParts(left: LocalParts, right: LocalParts): boolean {
  return Object.keys(left).every((key) => left[key as keyof LocalParts] === right[key as keyof LocalParts]);
}

/** 墙上时间 → UTC；DST 跳过的本地时间和非法 IANA 时区失败关闭。 */
export function zonedDateTimeToUtcIso(raw: string, timeZone: string): string | null {
  const match = DATE_TIME.exec(raw);
  if (match === null) return null;
  const parts: LocalParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  if (!validParts(parts)) return null;
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = zonedParts(instant, timeZone);
    if (rendered === null) return null;
    const renderedUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
    );
    const correction = target - renderedUtc;
    if (correction === 0) return sameParts(rendered, parts) ? new Date(instant).toISOString() : null;
    instant += correction;
  }
  const rendered = zonedParts(instant, timeZone);
  return rendered !== null && sameParts(rendered, parts) ? new Date(instant).toISOString() : null;
}

function parseDate(raw: string): LocalParts | null {
  const match = DATE.exec(raw);
  if (match === null) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
  return validParts(parts) ? parts : null;
}

function nextDate(parts: LocalParts): string {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export interface UtcRange {
  readonly from: string;
  readonly to: string;
}

/** 含尾日区间；尾界取下一日当地午夜减 1ms，正确覆盖 23/25 小时 DST 日。 */
export function zonedDateRangeToUtc(fromDate: string, toDate: string, timeZone: string): UtcRange | null {
  const fromParts = parseDate(fromDate);
  const toParts = parseDate(toDate);
  if (fromParts === null || toParts === null || fromDate > toDate) return null;
  const from = zonedDateTimeToUtcIso(`${fromDate}T00:00:00`, timeZone);
  const nextMidnight = zonedDateTimeToUtcIso(`${nextDate(toParts)}T00:00:00`, timeZone);
  if (from === null || nextMidnight === null) return null;
  return { from, to: new Date(Date.parse(nextMidnight) - 1).toISOString() };
}

export function isUtcRangeOrdered(from: string | null, to: string | null): boolean {
  return from === null || to === null || Date.parse(from) <= Date.parse(to);
}
