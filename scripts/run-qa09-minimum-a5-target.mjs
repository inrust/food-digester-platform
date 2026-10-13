import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { main, publishKnown } from './run-qa09-ten-device-acceptance.mjs';
import { callOwnS3Cli } from './qa09-own-s3-cli.mjs';
import { readOwnVersions } from './qa09-own-version-reader.mjs';
import {
  sha256,
  logRows,
  assertArchiveAssociation,
  assertNaturalSummary,
  assertPartialBatch,
  assertIngressArchive,
} from './qa09-minimum-a5-proof.mjs';
import { canonicalizeJson } from '../contracts/mqtt/payload-normalization.ts';
const exec = promisify(execFile);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const bucket = 'fdp-test-raw-065986019555';
async function aws(args, profile = 'esgiot-readonly', timeout = 30000) {
  const { stdout } = await exec(
    'aws',
    [
      ...args,
      '--profile',
      profile,
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
      '--no-cli-pager',
      '--cli-connect-timeout',
      '5',
      '--cli-read-timeout',
      '60',
    ],
    { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
  );
  return stdout.trim() ? JSON.parse(stdout) : {};
}
async function logs(group, start, pattern) {
  const events = [];
  let next;
  for (let page = 0; page < 20; page++) {
    const result = await aws([
      'logs',
      'filter-log-events',
      '--no-paginate',
      '--log-group-name',
      group,
      '--start-time',
      String(start),
      '--filter-pattern',
      pattern,
      '--limit',
      '100',
      ...(next ? ['--next-token', next] : []),
    ]);
    events.push(...(result.events ?? []));
    if (!result.nextToken || result.nextToken === next) return logRows(events);
    next = result.nextToken;
  }
  throw Error('BOUNDED_LOG_PAGES_EXCEEDED');
}
export function archiveBytes(receipt, key, manifestKey, expected, downloaded) {
  const archive = downloaded.result.objects.find((o) => o.key === key),
    manifestObject = downloaded.result.objects.find((o) => o.key === manifestKey);
  if (!archive || !manifestObject) throw Error('EXACT_DOWNLOADED_VERSIONS_REQUIRED');
  const versionId = archive.versionId,
    manifestVersionId = manifestObject.versionId;
  const bytes = Buffer.from(archive.bodyBase64, 'base64'),
    manifestBytes = Buffer.from(manifestObject.bodyBase64, 'base64');
  const manifest = JSON.parse(manifestBytes),
    lines = gunzipSync(bytes).toString().trim().split('\n').map(JSON.parse);
  if (
    manifest.key !== key ||
    manifest.customerId !== expected.customerId ||
    manifest.recordCount !== 1 ||
    manifest.eventIds?.length !== 1 ||
    manifest.eventIds[0] !== expected.eventId ||
    manifest.sha256 !== sha256(bytes) ||
    lines.length !== 1 ||
    lines[0].eventId !== expected.eventId ||
    lines[0].customerId !== expected.customerId
  )
    throw Error('EXACT_ARCHIVE_MANIFEST_BYTES_REQUIRED');
  const row = lines[0];
  return {
    key,
    manifestKey,
    versionId,
    manifestVersionId,
    compressedSha256: sha256(bytes),
    manifestSha256: sha256(manifestBytes),
    eventId: row.eventId,
    rawBodySha256: typeof row.rawBody === 'string' ? sha256(row.rawBody) : null,
    payloadSha256: row.payload ? sha256(canonicalizeJson(row.payload)) : null,
    ...(expected.published ? assertIngressArchive(row, expected.published, expected.certificateId) : {}),
  };
}
async function partialBatch(ctx, output) {
  const { receipt, save, check } = ctx;
  const customerId = receipt.customers[0].id,
    deviceId = receipt.devices[0];
  const eventId = randomUUID(),
    createdAt = new Date().toISOString();
  const payload = {
    archiveClass: 'MQTT_RAW',
    envelopeVersion: '1.0',
    topicType: 'ack',
    customerId,
    deviceId,
    occurredAt: createdAt,
    rawBody: '{}',
    payload: { meta: { id: 'QA09-DIRECT-ARCHIVE-FIXTURE', ts: createdAt, seq: 1, schemaVer: '1.0' }, data: {} },
  };
  const good = { eventId, eventType: 'ARCHIVE', aggregateType: 'device', aggregateId: deviceId, createdAt, payload };
  const badEventId = randomUUID();
  const goodIds = ['DIRECT-GOOD-' + randomUUID(), 'DIRECT-DUPLICATE-' + randomUUID()],
    badIds = ['DIRECT-BAD-JSON-' + randomUUID(), 'DIRECT-BAD-ENVELOPE-' + randomUUID()];
  const input = {
    Records: [
      { messageId: goodIds[0], body: JSON.stringify(good) },
      { messageId: badIds[0], body: '{' },
      {
        messageId: badIds[1],
        body: JSON.stringify({ ...good, eventId: badEventId, payload: { ...payload, topicType: 'INVALID_QA09_TYPE' } }),
      },
      { messageId: goodIds[1], body: JSON.stringify(good) },
    ],
  };
  const inputPath = output + '.partial-input.json',
    responsePath = output + '.partial-response.json';
  writeFileSync(inputPath, JSON.stringify(input));
  receipt.partialBatch = {
    provenance: 'DIRECT_LAMBDA_HANDLER_SYNTHETIC_RECORD_IDS_NOT_SQS_DELIVERY',
    eventId,
    badEventId,
    goodIds,
    badIds,
    inputSha256: sha256(readFileSync(inputPath)),
    state: 'SUBMITTING',
    startedAt: createdAt,
  };
  receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
  save();
  const metadata = await aws(
    [
      'lambda',
      'invoke',
      '--function-name',
      'fdp-test-archive',
      '--invocation-type',
      'RequestResponse',
      '--log-type',
      'Tail',
      '--payload',
      'fileb://' + inputPath,
      responsePath,
    ],
    'esgiot-infra',
    90000,
  );
  const response = JSON.parse(readFileSync(responsePath));
  receipt.partialBatch.invoke = {
    status: metadata.StatusCode,
    functionError: metadata.FunctionError ?? null,
    executedVersion: metadata.ExecutedVersion,
    logSha256: sha256(Buffer.from(metadata.LogResult ?? '', 'base64')),
  };
  if (metadata.StatusCode !== 200 || metadata.FunctionError) throw Error('DIRECT_ARCHIVE_INVOCATION_FAILED');
  receipt.partialBatch.response = response;
  receipt.partialBatch.proof = assertPartialBatch(response, badIds, goodIds);
  receipt.partialBatch.state = 'TERMINAL';
  delete receipt.cleanupHold;
  save();
  const prefix = `raw/topic_type=ack/customer_id=${customerId}/`;
  const listing = callOwnS3Cli(
    'list-objects-v2',
    { Bucket: bucket, Prefix: prefix },
    receipt.customers.map((c) => c.id),
  );
  const key = listing.Contents?.find((o) => o.Key.endsWith(`part-${sha256(eventId).slice(0, 16)}.json.gz`))?.Key;
  check('deployed-mixed-batch-good-object-present', !!key && !listing.IsTruncated);
  const manifestKey = key.replace('.json.gz', '.manifest.json');
  receipt.partialBatch.objectBinding = { key, manifestKey, eventId, customerId };
  check(
    'deployed-mixed-batch-bad-object-absent',
    !listing.Contents.some((o) => o.Key.includes(`part-${sha256(badEventId).slice(0, 16)}.`)),
  );
  check(
    'deployed-mixed-batch-duplicate-single-logical-object',
    listing.Contents.filter((o) => o.Key.endsWith('.json.gz')).length === 1 && listing.Contents.length === 2,
  );
  save();
}
export async function run(output, versionPath, mode = 'FULL') {
  if (!['FULL', '--archive-only'].includes(mode)) throw Error('EXPLICIT_A5_MODE_REQUIRED');
  if (!output || !versionPath || existsSync(output)) throw Error('FRESH_OUTPUT_AND_VERSION_REQUIRED');
  mkdirSync(dirname(output), { recursive: true });
  const sourcePaths = [
    'scripts/run-qa09-minimum-a5-target.mjs',
    'scripts/qa09-minimum-a5-proof.mjs',
    'scripts/qa09-own-version-reader.mjs',
    'scripts/run-qa09-ten-device-acceptance.mjs',
    'scripts/qa09-ten-device-db.mjs',
    'scripts/qa09-ten-device-bridge.mjs',
    'scripts/qa09-own-s3-cli.mjs',
    'scripts/collect-qa09-reliability-final.mjs',
    'scripts/device-simulator/core.mjs',
    'scripts/qa09-version-inputs.mjs',
    'scripts/qa09-operation-observation.mjs',
    'scripts/qa09-seed-recovery.mjs',
    'scripts/qa09-db-frame-wait.mjs',
    'scripts/qa09-started-build-read.mjs',
    'scripts/qa09-db-readonly-probe.mjs',
    'scripts/prepare-qa09-db-readonly-probe.mjs',
    'contracts/mqtt/payload-normalization.ts',
    'contracts/mqtt/topics.ts',
    'contracts/mqtt/validator.mjs',
    'apps/admin-web/src/auth/auth-flow.ts',
    'apps/admin-web/src/auth/cognito-idp.ts',
  ];
  if (existsSync(output + '.sources.json')) throw Error('FRESH_FROZEN_SOURCES_REQUIRED');
  writeFileSync(
    output + '.sources.json',
    JSON.stringify(
      {
        sources: sourcePaths.map((path) => {
          const bytes = readFileSync(path);
          return { path, sha256: sha256(bytes), sourceBase64: bytes.toString('base64') };
        }),
      },
      null,
      2,
    ) + '\n',
  );
  const extension = async (ctx) => {
    const { receipt, held, db, check, save } = ctx;
    receipt.batchArchiveCleanup = true;
    receipt.archiveOnly = mode === '--archive-only';
    receipt.remainderExecutorSources = [
      'run-qa09-minimum-a5-target.mjs',
      'qa09-minimum-a5-proof.mjs',
      'run-qa09-ten-device-acceptance.mjs',
      'qa09-ten-device-db.mjs',
      'qa09-ten-device-bridge.mjs',
      'qa09-own-s3-cli.mjs',
    ].map((file) => ({ file, sha256: sha256(readFileSync(new URL(file, import.meta.url))) }));
    const version = JSON.parse(readFileSync(versionPath));
    const checkCode = async () => {
      for (const name of ['fdp-test-archive', 'fdp-test-summary']) {
        const config = await aws(['lambda', 'get-function-configuration', '--function-name', name]);
        check(
          'current-code-' + name + '-' + receipt.checks.length,
          version.lambdaArtifacts.some((a) => a.name === name && a.codeSha256 === config.CodeSha256) &&
            config.State === 'Active' &&
            config.LastUpdateStatus === 'Successful',
        );
      }
    };
    await checkCode();
    const rule = await aws(['events', 'describe-rule', '--name', 'fdp-test-summary']);
    const targets = await aws(['events', 'list-targets-by-rule', '--rule', 'fdp-test-summary']);
    const mappings = await aws(['lambda', 'list-event-source-mappings', '--function-name', 'fdp-test-archive']);
    receipt.naturalRule = {
      name: rule.Name,
      state: rule.State,
      expression: rule.ScheduleExpression,
      targets: targets.Targets?.map((t) => ({
        id: t.Id,
        arn: t.Arn,
        hasInput: !!(t.Input || t.InputPath || t.InputTransformer),
      })),
    };
    receipt.archiveMappings = mappings.EventSourceMappings?.map((m) => ({
      uuid: m.UUID,
      state: m.State,
      arn: m.EventSourceArn,
      responseTypes: m.FunctionResponseTypes,
    }));
    check(
      'unchanged-natural-summary-and-archive-mapping',
      rule.State === 'ENABLED' &&
        rule.ScheduleExpression === 'rate(1 hour)' &&
        receipt.naturalRule.targets?.some((t) => t.arn.endsWith(':function:fdp-test-summary') && !t.hasInput) &&
        receipt.archiveMappings?.some(
          (m) =>
            m.state === 'Enabled' &&
            m.arn.endsWith(':fdp-test-archive') &&
            m.responseTypes?.includes('ReportBatchItemFailures'),
        ),
    );
    const id = receipt.devices[0],
      k = held.get(id),
      customerId = receipt.customers[0].id;
    const startedAt = new Date().toISOString();
    receipt.remainderStartedAt = startedAt;
    save();
    for (const type of ['telemetry', 'alarm', 'event', 'tamper']) {
      const data =
        type === 'tamper'
          ? {
              eventType: 'QA09_MINIMUM_WARNING',
              severity: 'WARNING',
              component: 'CLOUD_PROTOCOL_FIXTURE',
              actionTaken: 'RECORDED',
            }
          : undefined;
      const p = k.sim.payload(type, data);
      if (p.data.detectedTime) p.data.detectedTime = p.meta.ts;
      const raw = JSON.stringify(p);
      await publishKnown(k.client, `bnx/device/${id}/${type}`, raw, 45000);
      receipt.published.push({
        deviceId: id,
        customerId,
        type,
        seq: p.meta.seq,
        messageId: p.meta.id,
        bodySha256: sha256(raw),
        payloadSha256: sha256(canonicalizeJson(p)),
        publishedAt: new Date().toISOString(),
      });
      save();
    }
    console.log('Four remaining owned messages published; no Replay or full business rerun.');
    let observation = await db('consistency-observe');
    const wanted = receipt.published.filter((p) => p.type !== 'heartbeat');
    check(
      'four-new-receipts-persisted-with-hashes',
      wanted.every(
        (p) =>
          observation.receipts.filter(
            (r) =>
              r.device_id === p.deviceId &&
              r.topic_type === p.type &&
              r.seq === p.seq &&
              r.payload_hash === p.payloadSha256 &&
              r.result === 'PROCESSED',
          ).length === 1,
      ),
    );
    check(
      'signal-business-rows-persisted',
      observation.signalRows.alarms.some(
        (r) => r.device_id === id && r.source_message_id === wanted.find((p) => p.type === 'alarm').messageId,
      ) &&
        observation.signalRows.device_events.some(
          (r) => r.device_id === id && r.source_message_id === wanted.find((p) => p.type === 'event').messageId,
        ) &&
        observation.signalRows.tamper_events.some(
          (r) => r.device_id === id && r.source_message_id === wanted.find((p) => p.type === 'tamper').messageId,
        ),
    );
    check(
      'all-fixtures-remain-nonactive',
      observation.devices.every((d) => d.lifecycle_status === 'Onboarded'),
    );
    let archiveLogs;
    const archiveDeadline = Date.now() + 240000;
    while (true) {
      archiveLogs = await logs(
        '/aws/lambda/fdp-test-archive',
        Date.parse(startedAt) - 1000,
        '"archive.record.completed"',
      );
      if (
        wanted.every((p) => {
          const o = observation.outbox.find(
            (o) => o.aggregate_id === p.deviceId && o.topic_type === p.type && o.payload_hash === p.payloadSha256,
          );
          return o && archiveLogs.some((l) => l.eventId === o.id);
        })
      )
        break;
      if (Date.now() > archiveDeadline) throw Error('ARCHIVE_ASSOCIATION_DEADLINE');
      await pause(15000);
    }
    observation = await db('consistency-observe');
    const bindings = wanted.map((p) => {
      const event = observation.outbox.find(
        (o) => o.aggregate_id === p.deviceId && o.topic_type === p.type && o.payload_hash === p.payloadSha256,
      );
      const log = archiveLogs.find((l) => l.eventId === event.id && l.outcome === 'ARCHIVED');
      if (!log) throw Error('ARCHIVE_COMPLETED_RECEIPT_MISSING');
      const certs = JSON.parse(
        readFileSync(receipt.databaseBuilds.filter((b) => b.action === 'observe' && b.gate === 'PASS').at(-1).receipt),
      ).result.certificates;
      return {
        key: log.objectKey,
        manifestKey: log.manifestKey,
        eventId: event.id,
        customerId,
        published: p,
        certificateId: certs.find((c) => c.device_id === p.deviceId)?.id,
      };
    });
    await partialBatch(ctx, output);
    const allBindings = [...bindings, receipt.partialBatch.objectBinding];
    const objects = allBindings.flatMap((binding) =>
      [binding.key, binding.manifestKey].map((key) => {
        const page = callOwnS3Cli(
          'list-object-versions',
          { Bucket: bucket, Prefix: key },
          receipt.customers.map((c) => c.id),
        );
        const matches = (page.Versions ?? []).filter((v) => v.Key === key && v.IsLatest);
        if (page.IsTruncated || matches.length !== 1) throw Error('EXACT_LATEST_OBJECT_VERSION_REQUIRED');
        return { key, versionId: matches[0].VersionId };
      }),
    );
    receipt.archiveReaderReceipt = output + '.version-reader.json';
    save();
    const downloaded = await readOwnVersions(
      { prefix: receipt.prefix, customerIds: receipt.customers.map((c) => c.id), objects },
      receipt.archiveReaderReceipt,
    );
    receipt.archiveReaderSha256 = sha256(readFileSync(receipt.archiveReaderReceipt));
    receipt.normalArchiveObjects = bindings.map((b) => archiveBytes(receipt, b.key, b.manifestKey, b, downloaded));
    const direct = receipt.partialBatch.objectBinding;
    receipt.partialBatch.object = archiveBytes(receipt, direct.key, direct.manifestKey, direct, downloaded);
    receipt.archiveQueueProof = assertArchiveAssociation(
      wanted,
      observation.outbox,
      archiveLogs,
      receipt.normalArchiveObjects,
    );
    receipt.archiveLogs = archiveLogs.filter((l) => observation.outbox.some((o) => o.id === l.eventId));
    save();
    if (receipt.archiveOnly) {
      await checkCode();
      receipt.remainingA5Gate = 'PASS_ARCHIVE_REMAINDER_ONLY';
      receipt.naturalSummaryAssociation = 'SEPARATE_COMPATIBLE_ACTUAL_BUSINESS_PROOF_REQUIRED';
      save();
      return;
    }
    console.log('Archive queue and deployed mixed-batch separation verified; waiting for natural Summary.');
    const summaryDeadline = Date.now() + 75 * 60000;
    let summaryLogs, completed;
    while (true) {
      summaryLogs = await logs('/aws/lambda/fdp-test-summary', Date.parse(startedAt), '"summary.daily.upserted"');
      const candidate = summaryLogs.find(
        (l) =>
          l.deviceId === id &&
          l.customerId === customerId &&
          l.source === 'aws.events' &&
          Date.parse(l.eventTime) >= Date.parse(startedAt),
      );
      if (candidate) {
        completed = await logs('/aws/lambda/fdp-test-summary', Date.parse(startedAt), '"summary.run.completed"');
        if (completed.some((l) => l.eventId === candidate.eventId && l.lambdaRequestId === candidate.lambdaRequestId))
          break;
      }
      if (Date.now() > summaryDeadline) throw Error('NATURAL_SUMMARY_DEADLINE');
      await pause(30000);
    }

    observation = await db('consistency-observe');
    receipt.summaryProof = assertNaturalSummary(observation.telemetry_daily, [...summaryLogs, ...completed], {
      deviceId: id,
      customerId,
      notBefore: startedAt,
      ruleName: rule.Name,
    });
    receipt.summaryLogs = [
      ...summaryLogs.filter((l) => l.deviceId === id),
      ...completed.filter((l) => summaryLogs.some((u) => u.deviceId === id && u.lambdaRequestId === l.lambdaRequestId)),
    ];
    await checkCode();
    receipt.remainingA5Gate = 'PASS_MINIMUM_SCOPE';
    receipt.fullA5OriginalScopeAccepted = false;
    save();
  };
  extension.remainingOnly = true;
  extension.mqttPublishDeadlineMs = 45000;
  return main(output, versionPath, extension, { reviewOnly: false, remainingOnly: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  run(...process.argv.slice(2))
    .then((r) => {
      console.log(
        JSON.stringify({
          gate: r.gate,
          remainingA5Gate: r.remainingA5Gate,
          checks: r.checks.length,
          cleanup: r.cleanup.map((c) => ({ type: c.type, result: c.result, count: c.count })),
        }),
      );
      process.exitCode = r.gate === 'PASS' ? 0 : 1;
    })
    .catch((e) => {
      console.error(/^[A-Z_]+$/.test(e.message) ? e.message : 'MINIMUM_A5_FAILED');
      process.exitCode = 1;
    });
