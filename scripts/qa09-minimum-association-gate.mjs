import { sha256 } from './qa09-minimum-a5-proof.mjs';
export function archiveQueueWriteAssociation(parent, observed, logs) {
  const published = parent.published.filter((p) => p.type !== 'heartbeat');
  if (
    parent.failure?.code !== 'OWN_VERSION_READER_FAILED' ||
    published.length !== 4 ||
    new Set(published.map((p) => p.type)).size !== 4 ||
    observed.prefix !== parent.prefix ||
    observed.gate !== 'PASS' ||
    !observed.devices.every((d) => d.lifecycle_status === 'Onboarded')
  )
    throw Error('COMPLETE_OWN_NORMAL_BUSINESS_SCOPE_REQUIRED');
  const proofs = [];
  for (const p of published) {
    const matches = observed.outbox.filter(
      (o) =>
        o.event_type === 'ARCHIVE' &&
        o.aggregate_id === p.deviceId &&
        o.topic_type === p.type &&
        o.payload_hash === p.payloadSha256 &&
        /^[a-f0-9]{64}$/.test(o.raw_body_sha256 ?? '') &&
        o.status === 'PUBLISHED',
    );
    if (
      matches.length !== 1 ||
      observed.receipts.filter(
        (r) =>
          r.device_id === p.deviceId &&
          r.topic_type === p.type &&
          r.seq === p.seq &&
          r.payload_hash === p.payloadSha256 &&
          r.result === 'PROCESSED',
      ).length !== 1
    )
      throw Error('EXACT_PROCESSED_RECEIPT_AND_PUBLISHED_OUTBOX_REQUIRED');
    const o = matches[0],
      suffix = `/part-${sha256(o.id).slice(0, 16)}.json.gz`,
      prefix = `raw/topic_type=${p.type}/customer_id=${p.customerId}/`;
    const rows = logs.filter(
      (l) =>
        l.event === 'archive.record.completed' &&
        l.eventId === o.id &&
        l.schemaVersion === 1 &&
        l.source === 'aws:sqs' &&
        l.queueName === 'fdp-test-archive' &&
        /^[a-f0-9-]{36}$/.test(l.messageId ?? '') &&
        /^[a-f0-9-]{36}$/.test(l.lambdaRequestId ?? '') &&
        l.outcome === 'ARCHIVED' &&
        l.objectKey?.startsWith(prefix) &&
        l.objectKey.endsWith(suffix) &&
        l.manifestKey === l.objectKey.replace('.json.gz', '.manifest.json') &&
        /^[a-f0-9]{64}$/.test(l.compressedSha256 ?? ''),
    );
    if (
      !rows.length ||
      rows.some((l) => !parent.archiveKeys?.includes(l.objectKey) || !parent.archiveKeys.includes(l.manifestKey))
    )
      throw Error('ACTUAL_QUEUE_POST_STORAGE_RECEIPT_AND_OBSERVED_KEYS_REQUIRED');
    proofs.push({ type: p.type, receipts: rows.length });
  }
  if (!parent.cleanup.some((c) => c.type === 'archive-batch-owned-prefix' && c.result === 'PASS' && c.count === 10))
    throw Error('OWN_ACTUAL_OBJECT_VERSIONS_CLEANUP_REQUIRED');
  return {
    result: 'PASS',
    source: 'ACTUAL_MQTT_DB_OUTBOX_SQS_CONSUMER_POST_S3_WRITE_RECEIPT_AND_OBSERVED_OBJECT_KEYS',
    messages: 4,
    types: proofs.map((p) => p.type),
    newIndependentNormalObjectByteReadback: false,
  };
}
