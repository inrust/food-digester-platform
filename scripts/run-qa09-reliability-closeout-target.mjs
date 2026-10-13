import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { prepareOwnReplayOperator } from './qa09-own-replay-operator.mjs';
import { waitOwnDaily } from './qa09-wait-own-daily.mjs';
import { collectReplayProduction, requireReplayConsumerCompletion } from './qa09-replay-production-proof.mjs';
import { PROJECT } from './qa09-ten-device-db.mjs';
import {
  finishOwnReplayCleanup,
  refreshOwnTelemetrySession,
  replayGate,
  exactDuplicateGate,
  dedupGate,
  collectExactConsumption,
  submitOnce,
  sha256,
} from './qa09-reliability-closeout.mjs';
const exec = promisify(execFile);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const saveJson = (path, r) => writeFileSync(path, JSON.stringify(r, null, 2) + '\n');
export async function runReliabilityCloseout(output, versionPath, options = {}) {
  const a5 = options.a5 === true;
  if ([output, output + '.sources.json', output + '.reliability.json'].some(existsSync))
    throw Error('FRESH_RELIABILITY_OUTPUT_REQUIRED');
  const version = JSON.parse(readFileSync(versionPath));
  if (
    version.gate !== 'PASS' ||
    version.lambdaArtifacts?.length !== 19 ||
    version.lambdaArtifacts.some((a) => a.matches !== true)
  )
    throw Error('NINETEEN_VERIFIED_ARTIFACTS_REQUIRED');
  const sourcePaths = [
    'scripts/run-qa09-reliability-closeout-target.mjs',
    'scripts/qa09-reliability-closeout.mjs',
    'scripts/run-qa09-ten-device-acceptance.mjs',
    'scripts/qa09-ten-device-db.mjs',
    'scripts/qa09-ten-device-bridge.mjs',
    'scripts/qa09-data-path-evidence.mjs',
    'scripts/qa09-archive-reader.mjs',
    'scripts/qa09-archive-probe.mjs',
    'scripts/qa09-seed-recovery.mjs',
    'scripts/qa09-db-log-frames.mjs',
    'scripts/device-simulator/core.mjs',
    'contracts/mqtt/validator.mjs',
    'contracts/mqtt/topics.ts',
    'contracts/mqtt/payload-normalization.ts',
    'apps/admin-web/src/auth/auth-flow.ts',
    'apps/admin-web/src/auth/cognito-idp.ts',
    'scripts/qa09-own-s3-cli.mjs',
    'scripts/qa09-version-inputs.mjs',
    'scripts/qa09-db-frame-wait.mjs',
    'scripts/qa09-started-build-read.mjs',
    'scripts/qa09-operation-observation.mjs',
    'scripts/prepare-qa09-db-readonly-probe.mjs',
    'scripts/qa09-db-readonly-probe.mjs',
    'pnpm-lock.yaml',
  ];
  if (a5)
    sourcePaths.push(
      'scripts/run-qa09-a5-target.mjs',
      'scripts/qa09-own-replay-operator.mjs',
      'scripts/run-qa09-user-closeout-target.mjs',
      'scripts/qa09-replay-production-proof.mjs',
      'scripts/qa09-wait-own-daily.mjs',
      'scripts/qa09-esg-api.mjs',
    );
  saveJson(output + '.sources.json', {
    frozenAt: new Date().toISOString(),
    nodeVersion: process.version,
    sources: sourcePaths.map((path) => {
      const bytes = readFileSync(path);
      return { path, sha256: sha256(bytes), sourceBase64: bytes.toString('base64') };
    }),
  });
  let captured;
  const extension = async (ctx) => {
    const r = {
      task: a5 ? 'QA09-A5-NONACTIVE-RELIABILITY' : 'QA09-CLOSE-07',
      executionMode: a5 ? 'REAL_OPERATOR_REPLAY_BUSINESS_WORKER_NO_SSO_SEND' : 'LEGACY_SUPERADMIN_AND_DIRECT_QUEUE',
      prefix: ctx.receipt.prefix,
      sourceCommit: ctx.receipt.sourceCommit,
      versionSha256: sha256(readFileSync(versionPath)),
      startedAt: new Date().toISOString(),
      gate: 'RUNNING',
      builds: [],
      jobs: [],
      fullQa09Accepted: false,
      activeRequired: false,
      iamKmsOrCapacityChanges: false,
      queueReadOrPurge: false,
      replayProducerToSpecificSqsIdClaimed: false,
    };
    ctx.receipt.batchArchiveCleanup = true;
    const save = () => {
      saveJson(output + '.reliability.json', r);
      if (a5) saveJson(output, ctx.receipt); // Persist ownership holds before Operator writes.
    };
    save();
    const db = async (action, extra = {}) => {
      const plan = {
        prefix: ctx.receipt.prefix,
        devices: ctx.receipt.devices,
        customers: ctx.receipt.customers,
        action,
        ...extra,
      };
      const path = output + `.reliability-${action}-${r.builds.length}.json`;
      const row = { action, receipt: path, gate: 'RUNNING' };
      r.builds.push(row);
      save();
      try {
        const v = await runFixture(plan, path, (msg) => console.log(msg));
        if (
          v.gate !== 'PASS' ||
          v.sourceHash !== sha256(readFileSync('scripts/qa09-ten-device-db.mjs')) ||
          v.result?.sourceHash !== v.sourceHash ||
          v.result?.prefix !== plan.prefix ||
          v.result?.action !== action ||
          v.build?.status !== 'SUCCEEDED' ||
          !v.build.id?.startsWith(PROJECT + ':')
        )
          throw Error('BOUND_RELIABILITY_BUILD_REQUIRED');
        Object.assign(row, { gate: 'PASS', buildId: v.build.id, sha256: sha256(readFileSync(path)) });
        save();
        return v.result;
      } catch (e) {
        row.gate = 'FAIL';
        save();
        throw e;
      } // Original unknown-start receipt is never re-started.
    };
    const logRead = async (args, timeout) => {
      const response = await exec(
        'aws',
        [
          ...args,
          '--profile',
          'esgiot-infra',
          '--region',
          'ap-southeast-1',
          '--output',
          'json',
          '--no-cli-pager',
          '--cli-connect-timeout',
          '3',
          '--cli-read-timeout',
          '8',
        ],
        { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
      );
      return JSON.parse(response.stdout);
    };
    let businessBaseline,
      cleanupSafe = false,
      operator;
    try {
      const id = ctx.receipt.devices[2];
      const payload = captured && JSON.parse(captured.raw);
      if (
        captured?.deviceId !== id ||
        !ctx.receipt.published.some(
          (p) => p.deviceId === id && p.messageId === payload?.meta?.id && p.bodySha256 === sha256(captured.raw),
        )
      )
        throw Error('OWN_CAPTURE_BINDING_REQUIRED');
      const archived = ctx.receipt.archiveReaderEvidence;
      if (archived?.gate !== 'PASS' || archived.result?.allTelemetryArchived !== true)
        throw Error('ARCHIVE_BYTES_PROOF_REQUIRED');
      if (a5) await waitOwnDaily(ctx, r, save);
      const before = await db('reliability-observe');
      r.before = before;
      save();
      const receipt = before.receipts.find(
        (x) =>
          x.device_id === id && x.topic_type === 'telemetry' && x.seq === payload.meta.seq && x.result === 'PROCESSED',
      );
      if (!receipt || before.devices.some((d) => d.lifecycle_status === 'Active'))
        throw Error('OWN_NONACTIVE_PROCESSED_RECEIPT_REQUIRED');
      const observed = JSON.parse(
        readFileSync(ctx.receipt.databaseBuilds.filter((x) => x.action === 'observe').at(-1).receipt),
      ).result;
      const cert = observed.certificates.find((c) => c.device_id === id && c.status === 'ACTIVE');
      if (!/^[a-f0-9]{64}$/.test(cert?.id ?? '')) throw Error('OWN_VALID_CERT_REQUIRED');
      r.expected = {
        deviceId: id,
        messageId: payload.meta.id,
        receiptId: receipt.id,
        rawBodySha256: sha256(captured.raw),
        seq: payload.meta.seq,
      };
      businessBaseline = (await db('business-baseline')).businessFingerprints;
      if (a5) operator = await prepareOwnReplayOperator(ctx, r, save, output);
      const replayApi = operator ? operator.api : ctx.api;
      // Replay scope uses original occurred_at, not the later submission time.
      const at = Date.parse(receipt.occurred_at);
      const scope = {
        customerId: before.devices.find((d) => d.id === id).customer_id,
        deviceId: id,
        topicType: 'telemetry',
        from: new Date(at - 1000).toISOString(),
        to: new Date(at + 1000).toISOString(),
        seqFrom: payload.meta.seq,
        seqTo: payload.meta.seq,
      };
      const replayStartMs = Date.now();
      r.replayCreate = { gate: 'ATTEMPTING_NO_RETRY', scope };
      ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
      save();
      // A lost POST response may have created a Job: no automatic POST retry or cleanup of a running Job.
      const created = await replayApi('reliability:replay-create', 'POST', '/api/v1/admin/replay/jobs', 201, scope);
      const job = created?.data;
      if (!/^[a-f0-9-]{36}$/.test(job?.jobId ?? '')) throw Error('REPLAY_JOB_ID_REQUIRED');
      r.jobs.push({
        jobId: job.jobId,
        scope,
        requestedBy: job.requestedBy,
        role: a5 ? 'PlatformOperator' : 'PlatformSuperAdmin',
      });
      if (a5) r.operatorActorGate = job.requestedBy === r.operator.userId ? 'PASS_REAL_OPERATOR_ACTOR' : 'NO_RECEIPT';
      r.replayCreate.gate = 'CREATED';
      save();
      let completed;
      for (let i = 0; i < 36; i++) {
        const view = (
          await replayApi('reliability:replay-read-' + i, 'GET', '/api/v1/admin/replay/jobs/' + job.jobId, 200)
        ).data;
        r.jobs[0].view = view;
        save();
        if (['COMPLETED', 'FAILED'].includes(view.status)) {
          completed = view;
          cleanupSafe = true;
          if (!a5) delete ctx.receipt.cleanupHold;
          break;
        }
        await pause(5000);
      }
      r.replayGate = replayGate(completed, scope);
      save();
      if (!cleanupSafe) throw Error('REPLAY_NOT_TERMINAL_NO_DESTRUCTIVE_CLEANUP');
      if (a5) {
        r.production = await collectReplayProduction(
          {
            ...r.expected,
            jobId: job.jobId,
            topicType: 'telemetry',
            startMs: replayStartMs,
            endMs: Date.now() + 90000,
          },
          { read: logRead },
        );
        save();
        if (r.production.gate !== 'PASS_UNIQUE_REPLAY_JOB_PRODUCTION') throw Error('EXACT_REPLAY_PRODUCTION_REQUIRED');
        r.replayProducerToSpecificSqsIdClaimed = true;
      }
      r.replayConsumption = await collectExactConsumption(
        {
          ...r.expected,
          ...(a5 ? { sqsMessageId: r.production.sqsMessageId } : {}),
          startMs: replayStartMs,
          endMs: Date.now() + 90000,
        },
        { read: logRead },
      );
      if (a5)
        r.queueConsumptionGate = requireReplayConsumerCompletion(
          r.replayConsumption.rows,
          { ...r.expected, sqsMessageId: r.production.sqsMessageId },
          ctx.receipt,
        );
      save();
      if (!a5) {
        const client = new SQSClient({ region: 'ap-southeast-1', credentials: ctx.credentials, maxAttempts: 1 });
        const startMs = Date.now() - 1000;
        r.submission = await submitOnce(
          (input) => client.send(new SendMessageCommand(input), { abortSignal: AbortSignal.timeout(15000) }),
          (row) => {
            r.submission = row;
            save();
          },
          {
            QueueUrl: 'https://sqs.ap-southeast-1.amazonaws.com/065986019555/fdp-test-ingress',
            MessageBody: JSON.stringify({
              ...payload,
              iotTopic: `bnx/device/${id}/telemetry`,
              iotDeviceId: id,
              iotType: 'telemetry',
              iotReceivedAt: Date.now(),
              iotPrincipal: 'arn:aws:iot:ap-southeast-1:065986019555:cert/' + cert.id,
            }),
          },
        );
        if (r.submission.gate === 'UNKNOWN_SUBMISSION_NO_RETRY')
          ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
        if (r.submission.sqsMessageId) {
          const expected = {
            ...r.expected,
            sqsMessageId: r.submission.sqsMessageId,
            startMs,
            endMs: Date.now() + 90000,
          };
          r.consumption = await collectExactConsumption(expected, {
            read: async (args, timeout) => {
              const result = await exec(
                'aws',
                [
                  ...args,
                  '--profile',
                  'esgiot-infra',
                  '--region',
                  'ap-southeast-1',
                  '--output',
                  'json',
                  '--no-cli-pager',
                  '--cli-connect-timeout',
                  '3',
                  '--cli-read-timeout',
                  '8',
                ],
                { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
              );
              return JSON.parse(result.stdout);
            },
          });
          r.queueConsumptionGate = exactDuplicateGate(r.consumption.rows, expected);
        } else r.queueConsumptionGate = 'NOT_RUN_NO_SUBMISSION';
      } else {
        r.submission = { gate: 'NOT_REQUIRED_BUSINESS_REPLAY_PRODUCER_BOUND', ssoSendAttempts: 0 };
        // The exact consumer terminal gate above has already released the ownership hold.
      }
      r.after = await db('reliability-observe');
      r.dedupGate = dedupGate(before, r.after);
      r.replayAuditGate = ['replay.job.create', 'replay.job.execute'].every((action) =>
        r.after.audits.some((a) => a.object_id === job.jobId && a.action === action && a.result === 'SUCCESS'),
      )
        ? 'PASS'
        : 'NO_RECEIPT';
      r.gate =
        (!a5 || r.operatorActorGate === 'PASS_REAL_OPERATOR_ACTOR') &&
        r.replayGate.startsWith('PASS_') &&
        r.queueConsumptionGate.startsWith('PASS_') &&
        r.dedupGate.startsWith('PASS_') &&
        r.replayAuditGate === 'PASS'
          ? 'PASS_SCOPED_RELIABILITY'
          : 'PARTIAL';
      save();
    } catch (e) {
      const last = a5 ? r.operatorRequests?.at(-1) : ctx.receipt.checks.at(-1);
      if (last?.id === 'reliability:replay-create' && [400, 401, 403, 404, 409, 422].includes(last.status)) {
        cleanupSafe = true;
        delete ctx.receipt.cleanupHold;
        r.replayCreate.gate = 'REJECTED_NO_POST_RETRY';
      }
      r.gate = 'FAIL';
      r.failure = /^[A-Z0-9_:-]{1,100}$/.test(e.message) ? e.message : 'RELIABILITY_TARGET_FAILED';
      save();
      throw e;
    } finally {
      if (a5 && !businessBaseline && !ctx.receipt.cleanupHold) {
        try {
          businessBaseline = (await db('business-baseline')).businessFingerprints;
        } catch {
          ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
          r.gate = 'FAIL';
        }
      }
      if (operator) {
        try {
          r.operatorCleanup = await operator.cleanup();
        } catch {
          r.operatorCleanup = { gate: 'FAIL_OR_UNKNOWN_NO_RETRY' };
          r.gate = 'FAIL';
        }
        save();
      }
      const cleanup = await finishOwnReplayCleanup(
        {
          baseline: businessBaseline,
          terminal: cleanupSafe,
          postAttempted: r.replayCreate !== undefined,
          hold: ctx.receipt.cleanupHold,
        },
        db,
      );
      r.businessCleanup = cleanup.gate;
      if (['BLOCKED_UNKNOWN_OR_RUNNING_REPLAY', 'FAIL_OR_UNKNOWN_NO_MUTATION_RETRY'].includes(cleanup.gate)) {
        ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
        r.gate = 'FAIL';
      }
      r.finishedAt = new Date().toISOString();
      save();
    }
  };
  extension.mqttPublishDeadlineMs = 45000;
  extension.beforeDeviceTelemetry = refreshOwnTelemetrySession;
  extension.onCorePublished = ({ deviceId, raw }) => {
    if (deviceId.endsWith('-03') && !captured) captured = { deviceId, raw };
  };
  const result = await main(output, versionPath, extension);
  if (existsSync(output + '.reliability.json'))
    result.reliabilityGate = JSON.parse(readFileSync(output + '.reliability.json')).gate;
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, version] = process.argv.slice(2);
  const result = await runReliabilityCloseout(output, version);
  process.exitCode = result.gate === 'PASS' && result.reliabilityGate === 'PASS_SCOPED_RELIABILITY' ? 0 : 1;
}
