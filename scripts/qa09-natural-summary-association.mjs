/** Execution association only. Does not manufacture or claim an independent daily-value readback. */
export function naturalSummaryBusinessAssociation(parent, before, cleanup, rows) {
  const own = parent.devices?.[0],
    customer = parent.customers?.[0]?.id;
  const hourly = before.telemetry_hourly?.filter((r) => r.device_id === own && r.customer_id === customer) ?? [];
  const samples = hourly.reduce((sum, r) => sum + Number(r.sample_count), 0);
  if (
    parent.failure?.code !== 'OWN_VERSION_READER_FAILED' ||
    !parent.finishedAt ||
    before.prefix !== parent.prefix ||
    cleanup.prefix !== parent.prefix ||
    before.action !== 'consistency-observe' ||
    cleanup.action !== 'cleanup' ||
    before.gate !== 'PASS' ||
    cleanup.gate !== 'PASS' ||
    samples !== 1 ||
    cleanup.deleted?.telemetry_daily !== 1 ||
    cleanup.deleted?.telemetry_hourly !== 1 ||
    !before.devices.every((d) => d.lifecycle_status === 'Onboarded')
  )
    throw Error('EXACT_NONEMPTY_NATURAL_BUSINESS_SCOPE_REQUIRED');
  const upserts = rows.filter(
    (r) =>
      r.event === 'summary.daily.upserted' &&
      r.schemaVersion === 1 &&
      r.deviceId === own &&
      r.customerId === customer &&
      r.sampleCount === samples &&
      /^[a-f0-9]{64}$/.test(r.outputSha256 ?? '') &&
      /^[a-f0-9-]{36}$/.test(r.eventId ?? '') &&
      /^[a-f0-9-]{36}$/.test(r.lambdaRequestId ?? '') &&
      r.source === 'aws.events' &&
      r.ruleName === 'fdp-test-summary' &&
      Date.parse(r.eventTime) >= Date.parse(parent.remainderStartedAt),
  );
  if (
    upserts.length !== 1 ||
    !rows.some(
      (r) =>
        r.event === 'summary.run.completed' &&
        r.schemaVersion === 1 &&
        r.eventId === upserts[0].eventId &&
        r.lambdaRequestId === upserts[0].lambdaRequestId &&
        r.source === 'aws.events' &&
        r.ruleName === 'fdp-test-summary' &&
        r.eventTime === upserts[0].eventTime &&
        r.dailyUpserted > 0,
    )
  )
    throw Error('UNIQUE_NATURAL_UPSERT_AND_SAME_REQUEST_COMPLETION_REQUIRED');
  return {
    result: 'PASS',
    source: 'NATURAL_EVENTBRIDGE_POST_UPSERT_RECEIPT_AND_ACTUAL_OWN_DAILY_DELETE_COUNT',
    sampleCount: samples,
    actualDailyRowsDeleted: 1,
    uniqueInvocations: 1,
    independentDailyValueReadback: false,
    freshDataConsistencyReassessment: false,
    sharedSummaryInvocations: 0,
  };
}
