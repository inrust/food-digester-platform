/** R11: contract dates are calendar dates in Shanghai, stored as a half-open UTC interval. */
const DAY_MS = 86_400_000;
const shanghaiCalendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  era: 'short',
});

function shanghaiDate(instant: number) {
  const parts = shanghaiCalendar.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const year = get('era') === 'BC' ? 1 - Number(get('year')) : Number(get('year'));
  return { year, month: get('month'), day: get('day') };
}

export function contractDateBoundary(date: string, boundary: 'start' | 'end'): number | null {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) return null;

  // Find the first instant of the target Shanghai date using its IANA rules.
  const target = parsed + (boundary === 'end' ? DAY_MS : 0);
  const targetDate = new Date(target);
  const targetKey =
    targetDate.getUTCFullYear() * 10_000 + (targetDate.getUTCMonth() + 1) * 100 + targetDate.getUTCDate();
  let before = target - DAY_MS;
  let after = target + DAY_MS;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    const { year, month, day } = shanghaiDate(middle);
    if (year * 10_000 + Number(month) * 100 + Number(day) < targetKey) {
      before = middle;
    } else {
      after = middle;
    }
  }
  return after;
}

export function displayContractDate(timestamp: string, boundary: 'start' | 'end'): string {
  const instant = Date.parse(timestamp);
  // Display the last included date even when the stored end falls exactly at midnight.
  if (!Number.isFinite(instant)) return '—';
  const { year, month, day } = shanghaiDate(instant - (boundary === 'end' ? 1 : 0));
  return `${String(year).padStart(4, '0')}-${month}-${day}`;
}
