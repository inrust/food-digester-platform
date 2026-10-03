/** QA-09 budget excludes reserved PostgreSQL slots; operational/rotation headroom is mandatory. */
export const DATABASE_FUNCTION_CONCURRENCY = Object.freeze({
  ingestion: 1,
  'outbox-publisher': 1,
  'notification-publisher': 1,
  summary: 1,
  'replay-trigger-publisher': 1,
  replay: 1,
  'cert-package-sweeper': 1,
  'onboarding-deadline': 1,
  'retirement-timeout': 1,
  'activity-export': 1,
  'esg-export': 1,
  'command-publisher': 1,
  'command-timeout': 1,
  'ota-dispatcher': 1,
  'onboarding-provisioning': 1,
  'onboarding-api-handler': 2,
  'device-api-handler': 6,
  api: 8,
});
export type DatabaseFunctionName = keyof typeof DATABASE_FUNCTION_CONCURRENCY;
export function databaseCapacity(enabled: boolean, immediate: boolean) {
  if (immediate && !enabled) throw Error('IMMEDIATE_PUBLISH_REQUIRES_CAPACITY');
  const functions = Object.entries(DATABASE_FUNCTION_CONCURRENCY).map(([name, reservedConcurrency]) => ({
    name,
    reservedConcurrency:
      enabled && name === 'api' ? 12 : immediate && name === 'command-publisher' ? 2 : reservedConcurrency,
    poolMax: enabled && !['device-api-handler', 'onboarding-api-handler'].includes(name) ? 1 : 2,
  }));
  const steadyConnections = functions.reduce((n, f) => n + f.reservedConcurrency * f.poolMax, 0);
  const ordinarySlots = 70,
    operationalReserve = 8,
    idleOverlapReserve = 10;
  const required = steadyConnections + operationalReserve + idleOverlapReserve;
  if (enabled && required > ordinarySlots) throw Error('DATABASE_CAPACITY_BUDGET_EXCEEDED');
  return {
    functions,
    ordinarySlots,
    operationalReserve,
    idleOverlapReserve,
    steadyConnections,
    required,
    headroom: ordinarySlots - required,
  };
}
