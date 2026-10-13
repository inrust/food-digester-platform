import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { sha256, exactDuplicateGate } from './qa09-reliability-closeout.mjs';
/** A narrower, explicitly named proof. The original four-nonempty-table Gate is never relaxed. */
export function assessHourlyReplayDedup(before, after, devices) {
  const prefix = devices?.[0]?.slice(0, -3);
  if (
    !/^qa09-[a-f0-9]{16}$/.test(prefix ?? '') ||
    devices.length !== 10 ||
    devices.some((id, i) => id !== `${prefix}-${String(i + 1).padStart(2, '0')}`)
  )
    throw Error('EXACT_OWN_TEN_REQUIRED');
  const counts = { ingestion_receipts: 30, telemetry_hourly: 10, outbox_events: 20 };
  const valid = (r) =>
    r?.readOnly === true &&
    r.fingerprints?.length === 4 &&
    ['ingestion_receipts', 'telemetry_hourly', 'telemetry_daily', 'outbox_events'].every(
      (table) =>
        r.fingerprints.filter(
          (f) =>
            f.table === table &&
            /^[a-f0-9]{32}$/.test(f.digest) &&
            /^\d+$/.test(f.count) &&
            (table === 'telemetry_daily' ? Number(f.count) >= 0 : Number(f.count) === counts[table]),
        ).length === 1,
    ) &&
    r.receipts?.length === 30 &&
    r.receipts.every(
      (row) => devices.includes(row.device_id) && row.result === 'PROCESSED' && /^[a-f0-9]{64}$/.test(row.payload_hash),
    ) &&
    new Set(r.receipts.map((row) => `${row.device_id}/${row.topic_type}/${row.seq}`)).size === 30 &&
    devices.every(
      (id) =>
        r.receipts.filter((row) => row.device_id === id && row.topic_type === 'telemetry').length === 2 &&
        r.receipts.filter((row) => row.device_id === id && row.topic_type === 'heartbeat').length === 1,
    ) &&
    r.originalFingerprints?.length === 2;
  const passed =
    valid(before) &&
    valid(after) &&
    isDeepStrictEqual(before.fingerprints, after.fingerprints) &&
    isDeepStrictEqual(before.receipts, after.receipts) &&
    isDeepStrictEqual(before.originalFingerprints, after.originalFingerprints);
  const daily = before?.fingerprints?.find((f) => f.table === 'telemetry_daily');
  return {
    gate: passed ? 'PASS_HOURLY_ARCHIVE_DEDUP_SCOPE' : 'NO_RECEIPT',
    dailyGate: daily?.count === '0' ? 'NOT_RUN_NO_DAILY_ROWS' : 'NOT_ACCEPTED_DAILY_ROLLUP_NOT_EXERCISED',
    dailyUnchanged: passed,
    fullDedupGateChanged: false,
    fullQa09Accepted: false,
  };
}
export function reassessReplayDedup(parentPath, output) {
  if (existsSync(output)) throw Error('FRESH_ASSESSMENT_REQUIRED');
  const childPath = parentPath + '.reliability.json';
  const parent = JSON.parse(readFileSync(parentPath)),
    r = JSON.parse(readFileSync(childPath));
  if (
    !parent.finishedAt ||
    !r.finishedAt ||
    parent.prefix !== r.prefix ||
    parent.sourceCommit !== r.sourceCommit ||
    r.businessCleanup !== 'PASS'
  )
    throw Error('COMPLETED_SCOPE_AND_CLEANUP_REQUIRED');
  const source = JSON.parse(readFileSync(parentPath + '.sources.json')).sources.find(
    (s) => s.path === 'scripts/qa09-ten-device-db.mjs',
  );
  if (!source || sha256(Buffer.from(source.sourceBase64, 'base64')) !== source.sha256)
    throw Error('EXECUTED_DATABASE_SOURCE_REQUIRED');
  const builds = r.builds.filter((b) => b.action === 'reliability-observe');
  if (builds.length !== 2) throw Error('TWO_READONLY_OBSERVATIONS_REQUIRED');
  const frames = builds.map((b) => {
    const bytes = readFileSync(b.receipt),
      frame = JSON.parse(bytes);
    if (
      b.gate !== 'PASS' ||
      sha256(bytes) !== b.sha256 ||
      frame.gate !== 'PASS' ||
      frame.build?.status !== 'SUCCEEDED' ||
      frame.build.id !== b.buildId ||
      frame.result?.buildId !== b.buildId ||
      frame.sourceHash !== frame.result?.sourceHash ||
      frame.sourceHash !== source.sha256 ||
      frame.result?.prefix !== r.prefix ||
      frame.result?.action !== b.action ||
      frame.result.readOnly !== true
    )
      throw Error('READONLY_FRAME_BINDING_DRIFT');
    return frame.result;
  });
  if (!isDeepStrictEqual(frames[0], r.before) || !isDeepStrictEqual(frames[1], r.after))
    throw Error('OBSERVED_DATABASE_FACTS_DRIFT');
  const consumerIds = (r.replayConsumption?.matchedSqsMessageIds ?? []).filter(
    (sqsMessageId) =>
      exactDuplicateGate(r.replayConsumption.rows, { ...r.expected, sqsMessageId }) ===
      'PASS_EXACT_DUPLICATE_CONSUMPTION',
  );
  if (consumerIds.length !== 1) throw Error('ONE_EXACT_OWN_CONSUMER_PROOF_REQUIRED');
  const result = {
    task: 'QA09-CLOSE-07',
    sourceCommit: r.sourceCommit,
    prefix: r.prefix,
    ...assessHourlyReplayDedup(r.before, r.after, parent.devices),
    originalReliabilityGate: r.gate,
    originalFullDedupGate: r.dedupGate,
    originalDirectSubmissionGate: r.submission?.gate,
    originalReceiptsPreserved: true,
    businessReplayConsumerGate: 'PASS_EXACT_DUPLICATE_CONSUMPTION',
    sqsMessageIds: consumerIds,
    replayProducerToSpecificSqsIdClaimed: false,
    bindings: [parentPath, childPath, ...builds.map((b) => b.receipt)].map((path) => ({
      path,
      sha256: sha256(readFileSync(path)),
    })),
    sourceHash: sha256(readFileSync(new URL(import.meta.url))),
    sourceBase64: readFileSync(new URL(import.meta.url)).toString('base64'),
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = reassessReplayDedup(...process.argv.slice(2));
  process.exitCode = r.gate.startsWith('PASS_') ? 0 : 1;
}
