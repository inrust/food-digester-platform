import { createHash } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function dailyDigest(row) {
  return sha256(
    JSON.stringify(
      canonical({
        sampleCount: Number(row.sample_count),
        completenessPct: Number(row.completeness_pct),
        missingRecordCount: Number(row.missing_record_count),
        metrics: row.metrics,
      }),
    ),
  );
}
export function logRows(events) {
  return events.flatMap((event) => {
    try {
      return [JSON.parse(event.message.slice(event.message.indexOf('{')))];
    } catch {
      return [];
    }
  });
}
export function assertArchiveAssociation(published, outbox, logs, objects) {
  for (const p of published) {
    const events = outbox.filter(
      (o) =>
        o.event_type === 'ARCHIVE' &&
        o.aggregate_id === p.deviceId &&
        o.topic_type === p.type &&
        o.payload_hash === p.payloadSha256 &&
        o.status === 'PUBLISHED',
    );
    if (events.length !== 1) throw Error('EXACT_PUBLISHED_OUTBOX_REQUIRED');
    const matches = logs.filter(
      (l) =>
        l.event === 'archive.record.completed' &&
        l.eventId === events[0].id &&
        l.schemaVersion === 1 &&
        l.source === 'aws:sqs' &&
        l.queueName === 'fdp-test-archive' &&
        /^[a-f0-9-]{36}$/.test(l.messageId ?? '') &&
        /^[a-f0-9-]{36}$/.test(l.lambdaRequestId ?? '') &&
        l.outcome === 'ARCHIVED',
    );
    if (!matches.length) throw Error('REAL_ARCHIVE_QUEUE_RECEIPT_REQUIRED');
    for (const l of matches) {
      const ownPrefix = `raw/topic_type=${p.type}/customer_id=${p.customerId}/`;
      const found = objects.find(
        (o) =>
          o.key === l.objectKey &&
          o.manifestKey === l.manifestKey &&
          o.compressedSha256 === l.compressedSha256 &&
          o.eventId === events[0].id &&
          o.rawBodySha256 === events[0].raw_body_sha256 &&
          o.ingressPayloadSha256 === p.payloadSha256 &&
          o.ingressContextVerified === true &&
          o.messageId === p.messageId &&
          o.payloadSha256 === p.payloadSha256 &&
          o.versionId &&
          o.manifestVersionId,
      );
      if (!l.objectKey?.startsWith(ownPrefix) || !found) throw Error('EXACT_OWN_ARCHIVE_BYTES_REQUIRED');
    }
  }
  if (!published.length) throw Error('NONEMPTY_ARCHIVE_PROOF_REQUIRED');
  return { result: 'PASS', messages: published.length, source: 'ACTUAL_SQS_CONSUMER_AND_VERSIONED_S3_BYTES' };
}
export function assertNaturalSummary(rows, logs, { deviceId, customerId, notBefore, ruleName }) {
  const own = rows.filter(
    (r) => r.device_id === deviceId && r.customer_id === customerId && Number(r.sample_count) > 0,
  );
  if (!own.length) throw Error('NONEMPTY_DAILY_REQUIRED');
  for (const row of own) {
    const upserts = logs.filter(
      (l) =>
        l.event === 'summary.daily.upserted' &&
        l.schemaVersion === 1 &&
        l.deviceId === deviceId &&
        l.customerId === customerId &&
        l.siteId === row.site_id &&
        l.bucketDate === new Date(row.bucket_date).toISOString() &&
        l.outputSha256 === dailyDigest(row) &&
        l.sampleCount === Number(row.sample_count) &&
        l.source === 'aws.events' &&
        l.ruleName === ruleName &&
        /^[a-f0-9-]{36}$/.test(l.eventId ?? '') &&
        /^[a-f0-9-]{36}$/.test(l.lambdaRequestId ?? '') &&
        Date.parse(l.eventTime) >= Date.parse(notBefore),
    );
    if (!upserts.length) throw Error('EXACT_NATURAL_DAILY_UPSERT_REQUIRED');
    if (
      !upserts.some((u) =>
        logs.some(
          (l) =>
            l.event === 'summary.run.completed' &&
            l.schemaVersion === 1 &&
            l.source === 'aws.events' &&
            l.eventId === u.eventId &&
            l.lambdaRequestId === u.lambdaRequestId &&
            l.eventTime === u.eventTime &&
            l.ruleName === ruleName &&
            l.dailyUpserted > 0,
        ),
      )
    )
      throw Error('SAME_REQUEST_SUMMARY_COMPLETION_REQUIRED');
  }
  return { result: 'PASS', dailyRows: own.length, source: 'NATURAL_EVENTBRIDGE_AND_PERSISTED_DAILY_DIGEST' };
}
export function assertPartialBatch(response, badIds, goodIds) {
  const failures = response?.batchItemFailures?.map((r) => r.itemIdentifier).sort();
  if (
    !failures ||
    new Set(failures).size !== failures.length ||
    JSON.stringify(failures) !== JSON.stringify([...badIds].sort()) ||
    goodIds.some((id) => failures.includes(id))
  )
    throw Error('EXACT_PARTIAL_BATCH_RESPONSE_REQUIRED');
  return {
    result: 'PASS',
    failed: badIds.length,
    successful: goodIds.length,
    source: 'DIRECT_DEPLOYED_HANDLER_FIXTURE_NOT_SQS_DELIVERY',
    actualPoisonRetryOrDlqProven: false,
  };
}

export function assertIngressArchive(row, published, certificateId) {
  const envelope = JSON.parse(row.rawBody);
  const reserved = ['iotTopic', 'iotDeviceId', 'iotType', 'iotReceivedAt', 'iotPrincipal'];
  const payload = Object.fromEntries(Object.entries(envelope).filter(([key]) => !reserved.includes(key)));
  const digest = (value) => sha256(JSON.stringify(canonical(value)));
  if (
    !/^[a-f0-9]{64}$/.test(certificateId ?? '') ||
    row.deviceId !== published.deviceId ||
    row.customerId !== published.customerId ||
    row.topicType !== published.type ||
    row.payload?.meta?.id !== published.messageId ||
    envelope.meta?.id !== published.messageId ||
    envelope.meta?.seq !== published.seq ||
    envelope.iotTopic !== `bnx/device/${published.deviceId}/${published.type}` ||
    envelope.iotDeviceId !== published.deviceId ||
    envelope.iotType !== published.type ||
    !Number.isSafeInteger(envelope.iotReceivedAt) ||
    envelope.iotReceivedAt < 0 ||
    row.receivedAtMs !== envelope.iotReceivedAt ||
    ![certificateId, `arn:aws:iot:ap-southeast-1:065986019555:cert/${certificateId}`].includes(envelope.iotPrincipal) ||
    digest(payload) !== published.payloadSha256 ||
    digest(row.payload) !== published.payloadSha256
  )
    throw Error('EXACT_BROKER_ENVELOPE_AND_PUBLISHED_PAYLOAD_REQUIRED');
  return {
    rawBodySha256: sha256(row.rawBody),
    ingressPayloadSha256: digest(payload),
    ingressContextVerified: true,
    messageId: envelope.meta.id,
  };
}
