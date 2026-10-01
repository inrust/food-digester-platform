/** QA-07 user-approved 2026-10-01: only Telemetry permits 24-hour historical backfill. */
export const TELEMETRY_BACKFILL_POLICY = Object.freeze({
  version: '1.0.0',
  maxPastAgeSeconds: 86400,
  defaultFutureToleranceSeconds: 300,
  inclusiveBoundary: true,
});
export function messageTimeWithinWindow(
  topicType: string,
  occurredAtMs: number,
  receivedAtMs: number,
  toleranceSeconds: number,
): boolean {
  if (![occurredAtMs, receivedAtMs, toleranceSeconds].every(Number.isFinite) || toleranceSeconds < 0) return false;
  const age = (receivedAtMs - occurredAtMs) / 1000;
  const pastLimit = topicType === 'telemetry' ? TELEMETRY_BACKFILL_POLICY.maxPastAgeSeconds : toleranceSeconds;
  return age >= -toleranceSeconds && age <= pastLimit;
}
