import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const allowedEvents = new Set([
  'data-path.phase.completed',
  'ingestion.receipt.completed',
  'ingestion.record.completed',
]);
const fields = [
  'event',
  'lambdaRequestId',
  'gatewayRequestId',
  'operationId',
  'sqsMessageId',
  'deviceId',
  'messageId',
  'topicType',
  'seq',
  'receivedAtMs',
  'occurredAtMs',
  'coldStart',
  'phase',
  'durationMs',
  'outcome',
  'errorCode',
  'startedAt',
  'completedAt',
  'includesConnectionWait',
  'receiptId',
  'receiptOutcome',
  'commitScope',
  'disposition',
  'businessDispatchCompleted',
];

/** Project fixed metadata only; never archive arbitrary log messages or fields. */
export function projectDataPathLog(message) {
  let row;
  try {
    row = JSON.parse(message.slice(message.indexOf('{')));
  } catch {
    return null;
  }
  if (!row || !allowedEvents.has(row.event)) return null;
  const projected = {};
  for (const key of fields) {
    const v = row[key];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && v >= 0)) projected[key] = v;
    else if (
      typeof v === 'string' &&
      (['startedAt', 'completedAt'].includes(key)
        ? /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)
        : /^[A-Za-z0-9_-]{1,128}$/.test(v))
    )
      projected[key] = v;
  }
  return projected;
}
export function queueConsumptionGate(rows, expected) {
  if (!expected?.sqsMessageId || !expected?.messageId || !expected?.deviceId) return 'NOT_RUN_NO_SUBMITTED_REDELIVERY';
  const final = rows.find(
    (r) =>
      r.event === 'ingestion.record.completed' &&
      r.sqsMessageId === expected.sqsMessageId &&
      r.messageId === expected.messageId &&
      r.deviceId === expected.deviceId &&
      r.disposition === 'PROCESSED' &&
      r.receiptOutcome === 'DUPLICATE_SKIPPED' &&
      r.receiptId &&
      r.receiptId !== 'unknown',
  );
  return final &&
    rows.some(
      (r) =>
        r.event === 'ingestion.receipt.completed' &&
        r.sqsMessageId === expected.sqsMessageId &&
        r.receiptId === final.receiptId &&
        r.receiptOutcome === 'DUPLICATE_SKIPPED' &&
        r.commitScope === 'ROOT_TRANSACTION_COMPLETED',
    )
    ? 'PASS_SPECIFIC_SQS_REDELIVERY_COMPLETED'
    : 'NO_RECEIPT';
}
export function ownedDataPathGate(rows, prefix) {
  if (!/^qa09-[a-f0-9]{16}$/.test(prefix)) throw Error('OWN_PREFIX_REQUIRED');
  const own = rows.filter(
    (r) =>
      typeof r.deviceId === 'string' &&
      r.deviceId.startsWith(prefix + '-') &&
      r.seq >= 10000 &&
      r.seq < 10020 &&
      r.topicType === 'telemetry',
  );
  const missing = [];
  for (let seq = 10000; seq < 10020; seq++) {
    const group = own.filter((r) => r.seq === seq && r.deviceId === prefix + '-01');
    const root = group.find(
      (r) =>
        r.event === 'ingestion.receipt.completed' &&
        r.receiptOutcome === 'PROCESSED' &&
        r.commitScope === 'ROOT_TRANSACTION_COMPLETED',
    );
    const final =
      root &&
      group.find(
        (r) =>
          r.event === 'ingestion.record.completed' &&
          r.sqsMessageId === root.sqsMessageId &&
          r.receiptId === root.receiptId &&
          r.disposition === 'PROCESSED',
      );
    if (
      !final ||
      !['db-transaction', 'db-business', 'db-gap', 'telemetry-aggregate', 'telemetry-archive-outbox'].every((phase) =>
        group.some((r) => r.phase === phase && r.outcome === 'PASS' && r.sqsMessageId === root.sqsMessageId),
      )
    )
      missing.push(seq);
  }
  const consoleObserved = rows.some(
    (r) => r.deviceId === prefix + '-01' && r.phase === 'console-read' && r.outcome === 'PASS',
  );
  return {
    gate: missing.length === 0 && consoleObserved ? 'PASS_SCOPED_STAGE_EVIDENCE' : 'NO_RECEIPT',
    missingTelemetrySequences: missing,
    consoleObserved,
    fullQa09Accepted: false,
  };
}

export async function collectDataPathEvidence(probesPath, versionPath, output) {
  const probes = JSON.parse(readFileSync(probesPath));
  const version = JSON.parse(readFileSync(versionPath));
  const prefix = probes.prefix;
  if (!/^qa09-[a-f0-9]{16}$/.test(prefix) || version.gate !== 'PASS' || version.sourceCommit !== probes.sourceCommit)
    throw Error('PASSED_SAME_SHA_VERSION_AND_OWN_PREFIX_REQUIRED');
  const start = Date.parse(probes.startedAt),
    end = Date.parse(probes.finishedAt) + 300000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 6 * 3600000)
    throw Error('BOUNDED_TIME_WINDOW_REQUIRED');
  const aws = async (args) => {
    const r = await exec(
      'aws',
      [...args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
    );
    return JSON.parse(r.stdout);
  };
  if ((await aws(['sts', 'get-caller-identity'])).Account !== '065986019555') throw Error('WRONG_TEST_ACCOUNT');
  const functions = version.lambdaArtifacts.filter(
    (r) => /^(ApiFn|IngestionFn)/.test(r.logicalId) && r.matches === true,
  );
  if (functions.length !== 2 || functions.some((r) => !['fdp-test-api', 'fdp-test-ingestion'].includes(r.name)))
    throw Error('EXACT_TEST_LOG_GROUPS_REQUIRED');
  const rows = [],
    reads = [];
  const devices = Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0'));
  for (const fn of functions) {
    const logGroup = '/aws/lambda/' + fn.name;
    let token;
    for (let page = 0; page < 20; page++) {
      const args = [
        'logs',
        'filter-log-events',
        '--log-group-name',
        logGroup,
        '--start-time',
        String(start),
        '--end-time',
        String(end),
        '--filter-pattern',
        '{ ' + devices.map((id) => `($.deviceId = "${id}")`).join(' || ') + ' }',
        '--limit',
        '10000',
        '--no-paginate',
      ];
      if (token) args.push('--next-token', token);
      const response = await aws(args);
      for (const event of response.events ?? []) {
        const row = projectDataPathLog(event.message);
        if (row && devices.includes(row.deviceId)) rows.push({ ...row, logGroup, observedAtMs: event.timestamp });
      }
      reads.push({ logGroup, page, eventCount: response.events?.length ?? 0 });
      if (!response.nextToken || response.nextToken === token) break;
      if (page === 19) throw Error('LOG_READ_LIMIT_REACHED');
      token = response.nextToken;
    }
  }
  const queue = probes.performance?.queueRedelivery;
  const receipt = {
    task: 'QA-09',
    scope: 'OWN_TEST_DATA_PATH_FIXED_METADATA_READ_ONLY',
    prefix,
    sourceCommit: probes.sourceCommit,
    collectedAt: new Date().toISOString(),
    reads,
    rows,
    ...ownedDataPathGate(rows, prefix),
    queueConsumptionGate: queueConsumptionGate(rows, queue ? { ...queue, deviceId: prefix + '-01' } : null),
    rawPayloadsArchived: false,
    iamOrKmsChanged: false,
  };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [probes, version, output] = process.argv.slice(2);
  if (!probes || !version || !output) throw Error('PROBES_VERSION_OUTPUT_REQUIRED');
  try {
    const receipt = await collectDataPathEvidence(probes, version, output);
    console.log(
      JSON.stringify({
        gate: receipt.gate,
        prefix: receipt.prefix,
        rowCount: receipt.rows.length,
        queueConsumptionGate: receipt.queueConsumptionGate,
      }),
    );
    process.exitCode = receipt.gate === 'PASS_SCOPED_STAGE_EVIDENCE' ? 0 : 1;
  } catch (e) {
    console.error(
      JSON.stringify({
        gate: 'NO_RECEIPT',
        code: /^[A-Z_]+$/.test(e.message) ? e.message : 'READ_ONLY_LOG_COLLECTION_FAILED',
      }),
    );
    process.exitCode = 1;
  }
}
