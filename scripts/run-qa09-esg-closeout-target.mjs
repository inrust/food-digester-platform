import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectAsync } from 'mqtt';
import { S3Client, ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { main, publishKnown } from './run-qa09-ten-device-acceptance.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { readOwnArchives } from './qa09-archive-reader.mjs';
import { canonical } from './qa09-archive-probe.mjs';
import { sha256, refreshOwnTelemetrySession } from './qa09-reliability-closeout.mjs';
import {
  assertConsistency,
  assertCsvDatabase,
  assertLeaseRecovery,
  waitRead,
  cleanupFailureRequiresHold,
} from './qa09-esg-closeout.mjs';
import { readEsgList } from './qa09-esg-api.mjs';
const saveJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export async function runEsgCloseout(output, versionPath) {
  if ([output, output + '.sources.json', output + '.reliability.json'].some(existsSync))
    throw Error('FRESH_ESG_WAVE_REQUIRED');
  const version = JSON.parse(readFileSync(versionPath));
  if (
    version.gate !== 'PASS' ||
    version.lambdaArtifacts?.length !== 19 ||
    version.lambdaArtifacts.some((a) => a.matches !== true)
  )
    throw Error('NINETEEN_VERIFIED_ARTIFACTS_REQUIRED');
  const paths = [
    'scripts/run-qa09-esg-closeout-target.mjs',
    'scripts/qa09-esg-closeout.mjs',
    'scripts/qa09-esg-api.mjs',
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
    'apps/cloud-api/src/admin/esg/csv.ts',
    'pnpm-lock.yaml',
  ];
  saveJson(output + '.sources.json', {
    frozenAt: new Date().toISOString(),
    nodeVersion: process.version,
    sources: paths.map((path) => {
      const b = readFileSync(path);
      return { path, sha256: sha256(b), sourceBase64: b.toString('base64') };
    }),
  });
  const telemetry = [];
  const extension = async (ctx) => {
    const r = {
      task: 'QA09-CLOSE-07',
      scope: 'OWN_REAL_MQTT_REPORT_NATURAL_DAILY_AND_EXPORT_LEASE',
      sourceCommit: version.sourceCommit,
      versionSha256: sha256(readFileSync(versionPath)),
      prefix: ctx.receipt.prefix,
      startedAt: new Date().toISOString(),
      gate: 'RUNNING',
      builds: [],
      jobs: [],
      reports: [],
      telemetry,
      checks: [],
      polls: [],
      cleanup: [],
      fullQa09Accepted: false,
      activeRequired: false,
      iamKmsOrCapacityChanges: false,
      sharedWorkerInvocations: 0,
    };
    const save = () => saveJson(output + '.reliability.json', r);
    ctx.receipt.batchArchiveCleanup = true;
    save();
    let baseline,
      lastAuth = Date.now();
    const proof = (id, ok) => {
      r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
      save();
      if (!ok) throw Error('ESG_CLOSEOUT_ASSERTION_FAILED');
    };
    const refresh = async () => {
      if (Date.now() - lastAuth > 20 * 60 * 1000) {
        await ctx.refreshIdentity();
        lastAuth = Date.now();
      }
    };
    const db = async (action, extra = {}) => {
      const path = output + `.esg-${action}-${r.builds.length}.json`,
        row = { action, receipt: path, gate: 'RUNNING' };
      r.builds.push(row);
      save();
      const write = !['consistency-observe', 'business-baseline', 'business-audit'].includes(action);
      if (write) {
        ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
        save();
      }
      try {
        const v = await runFixture(
          {
            prefix: r.prefix,
            devices: ctx.receipt.devices,
            customers: ctx.receipt.customers,
            action,
            semanticExportIds: r.jobs.map((j) => j.id).filter(Boolean),
            ...extra,
          },
          path,
          console.log,
        );
        if (
          v.gate !== 'PASS' ||
          v.build?.status !== 'SUCCEEDED' ||
          v.sourceHash !== sha256(readFileSync('scripts/qa09-ten-device-db.mjs')) ||
          v.result?.sourceHash !== v.sourceHash ||
          v.result?.prefix !== r.prefix ||
          v.result?.action !== action
        )
          throw Error('BOUND_ESG_BUILD_REQUIRED');
        Object.assign(row, { gate: 'PASS', buildId: v.build.id, sha256: sha256(readFileSync(path)) });
        if (write) delete ctx.receipt.cleanupHold;
        save();
        return v.result;
      } catch (e) {
        row.gate = 'FAIL';
        save();
        throw e;
      }
    };
    const query = async (dataset, id) => {
      await refresh();
      const route = { HOURLY: 'hourly', DAILY: 'daily', REPORTS: 'reports', DAILY_SUMMARY: 'daily-summary' }[dataset];
      const customer = ctx.receipt.customers[ctx.receipt.devices.indexOf(id) < 5 ? 0 : 1].id;
      const v = await ctx.api(
        'close-esg:query:' + dataset + ':' + r.polls.length,
        'GET',
        `/api/v1/admin/esg/${route}?deviceId=${id}&customerId=${customer}&limit=100`,
        200,
      );
      return readEsgList(v, { deviceId: id, customerId: customer });
    };
    const terminal = async (job, label) =>
      waitRead(
        async (n) => {
          await refresh();
          const v = (await ctx.api('close-esg:' + label + ':' + n, 'GET', '/api/v1/admin/esg/exports/' + job.id, 200))
            .data;
          // Only safe metadata persists. Signed download URLs remain in memory.
          job.view = {
            exportId: v.exportId,
            dataset: v.dataset,
            status: v.status,
            filters: v.filters,
            rowCount: v.rowCount,
            requestedBy: v.requestedBy,
            createdAt: v.createdAt,
            completedAt: v.completedAt,
          };
          save();
          if (
            v.exportId !== job.id ||
            v.dataset !== job.dataset ||
            v.filters?.deviceId !== ctx.receipt.devices[0] ||
            v.filters?.customerId !== ctx.receipt.customers[0].id
          )
            throw Error('EXPORT_VIEW_SCOPE_DRIFT');
          return v;
        },
        (v) => ['COMPLETED', 'FAILED'].includes(v.status),
        {
          budgetMs: 240000,
          intervalMs: 5000,
          observe: (p) => {
            r.polls.push({ stage: label, ...p });
            save();
          },
        },
      );
    const download = async (view, dataset, frame, label) => {
      if (view.status !== 'COMPLETED' || typeof view.downloadUrl !== 'string') throw Error('COMPLETED_EXPORT_REQUIRED');
      const u = new URL(view.downloadUrl);
      if (
        u.protocol !== 'https:' ||
        u.hostname !== 'fdp-test-export-065986019555.s3.ap-southeast-1.amazonaws.com' ||
        decodeURIComponent(u.pathname) !== '/esg-exports/' + view.exportId + '.csv'
      )
        throw Error('EXACT_OWN_DOWNLOAD_REQUIRED');
      const response = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > 1048576)
        throw Error('EXPORT_DOWNLOAD_FAILED');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 1048576) throw Error('EXPORT_SIZE_LIMIT');
      const text = bytes.toString('utf8'),
        result = assertCsvDatabase(text, dataset, frame, ctx.receipt.devices[0], ctx.receipt.customers[0].id);
      proof(label + ':api-row-count', result.rowCount === view.rowCount);
      writeFileSync(output + '.' + label + '.csv', bytes);
      return { text, result };
    };
    const cleanupCompletedWrites = async () => {
      const s3 = new S3Client({ region: 'ap-southeast-1', credentials: ctx.credentials, maxAttempts: 1 });
      for (const job of r.jobs.filter((j) => j.id)) {
        if (!/^[a-f0-9-]{36}$/.test(job.id ?? '')) throw Error('EXACT_EXPORT_LEDGER_REQUIRED');
        const key = 'esg-exports/' + job.id + '.csv',
          list = async () =>
            s3.send(
              new ListObjectVersionsCommand({ Bucket: 'fdp-test-export-065986019555', Prefix: key, MaxKeys: 100 }),
              { abortSignal: AbortSignal.timeout(15000) },
            );
        const versions = await list();
        if (versions.IsTruncated) throw Error('EXPORT_VERSION_LIMIT');
        const rows = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])];
        if (rows.some((v) => v.Key !== key)) throw Error('EXPORT_OBJECT_SCOPE_DRIFT');
        for (const v of rows) {
          r.cleanup.push({ key, versionId: v.VersionId, result: 'ATTEMPTING_NO_RETRY' });
          save();
          await s3.send(
            new DeleteObjectCommand({ Bucket: 'fdp-test-export-065986019555', Key: key, VersionId: v.VersionId }),
            { abortSignal: AbortSignal.timeout(15000) },
          );
          r.cleanup.at(-1).result = 'PASS';
          save();
        }
        const rest = await list();
        proof(
          'export-versions-empty:' + job.id,
          !rest.IsTruncated && !rest.Versions?.length && !rest.DeleteMarkers?.length,
        );
      }
      baseline ??= (await db('business-baseline')).businessFingerprints;
      await db('business-cleanup', { businessBaseline: baseline });
      await db('business-audit', { businessBaseline: baseline });
      r.businessCleanup = 'PASS';
    };
    try {
      for (const id of [ctx.receipt.devices[0], ctx.receipt.devices[5]]) {
        const k = ctx.held.get(id);
        await refreshOwnTelemetrySession({ id, k, receipt: ctx.receipt, clients: [], connectAsync });
        try {
          const at = new Date(),
            start = new Date(at.getTime() - 60000);
          const data = {
            reportType: 'CYCLE',
            periodStartTime: start.toISOString(),
            periodEndTime: at.toISOString(),
            feedingWeightKg: 12,
            dischargeWeightKg: 4,
            reductionWeightKg: 8,
            cycleCount: 1,
            processingDurationMinutes: 1,
            energyConsumptionKwh: 3,
            averagePowerKw: 3,
            averageO2Pct: 20,
            averageCo2Ppm: 400,
            averageCh4Ppm: 2,
            averageN2oPpm: 1,
            carbonReductionKg: 5,
            carbonReductionMethod: 'DEFAULT_V1',
            dataCompletenessPct: 100,
            missingRecordCount: 0,
          };
          const p = k.sim.payload('report', data),
            raw = JSON.stringify(p),
            row = {
              deviceId: id,
              type: 'report',
              messageId: p.meta.id,
              seq: p.meta.seq,
              occurredAt: p.meta.ts,
              data,
              bodySha256: sha256(raw),
              payloadSha256: sha256(canonical(p)),
              publish: 'ATTEMPTING_NO_RETRY',
            };
          // Record before publication, including on timeout; report prefixes always remain owned cleanup scope.
          r.reports.push(row);
          ctx.receipt.published.push({ ...row, data: undefined });
          save();
          await publishKnown(k.client, `bnx/device/${id}/report`, raw, 45000);
          row.publish = 'PUBACK';
          save();
          await publishKnown(k.client, `bnx/device/${id}/report`, raw, 45000);
          row.knownDuplicatePuback = true;
          save();
        } finally {
          await k.client.endAsync(true).catch(() => {});
        }
      }
      // No manual invocation of the shared Summary worker: wait for its configured natural schedule.
      r.naturalSchedule = {
        startedAt: new Date().toISOString(),
        budgetMs: 4500000,
        intervalMs: 30000,
        manualInvocations: 0,
      };
      save();
      await waitRead(
        async () => {
          const daily = await query('DAILY', ctx.receipt.devices[0]),
            summary = await query('DAILY_SUMMARY', ctx.receipt.devices[0]),
            secondSummary = await query('DAILY_SUMMARY', ctx.receipt.devices[5]);
          return { daily: daily.length, summary: summary.length, secondSummary: secondSummary.length };
        },
        (v) => v.daily > 0 && v.summary > 0 && v.secondSummary > 0,
        {
          budgetMs: 4500000,
          intervalMs: 30000,
          observe: (p) => {
            r.polls.push({ stage: 'natural-summary', ...p });
            save();
          },
        },
      );
      r.naturalSchedule.observedAt = new Date().toISOString();
      save();
      const frame = await db('consistency-observe');
      r.consistencyFrame = frame;
      r.consistency = assertConsistency(frame, telemetry, r.reports, ctx.receipt.devices, ctx.receipt.customers);
      save();
      ctx.receipt.archiveProfile = 'QA09_REPORT_CONSISTENCY';
      const archiveObservation = { outbox: frame.outbox.map((o) => ({ id: o.id, rawBodySha256: o.raw_body_sha256 })) };
      r.archive = await readOwnArchives(ctx.receipt, archiveObservation, output + '.reports-archive.json');
      proof(
        'twenty-telemetry-and-two-reports-raw-hashes',
        r.archive.gate === 'PASS' &&
          r.archive.result.allReportsArchived === true &&
          r.archive.result.archivedMessages === 22,
      );
      baseline = (await db('business-baseline')).businessFingerprints;
      for (const dataset of ['HOURLY', 'DAILY', 'REPORTS', 'DAILY_SUMMARY']) {
        const job = { dataset, submission: 'ATTEMPTING_NO_RETRY' };
        r.jobs.push(job);
        ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
        save();
        const created = (
          await ctx.api('close-esg:create:' + dataset, 'POST', '/api/v1/admin/esg/exports', 202, {
            dataset,
            customerId: ctx.receipt.customers[0].id,
            deviceId: ctx.receipt.devices[0],
          })
        ).data;
        if (!/^[a-f0-9-]{36}$/.test(created?.exportId ?? '')) throw Error('EXPORT_CREATED_ID_REQUIRED');
        job.id = created.exportId;
        job.submission = 'CREATED';
        job.requestedBy = created.requestedBy;
        save();
        const v = await terminal(job, 'initial:' + dataset);
        delete ctx.receipt.cleanupHold;
        save();
        if (v.status !== 'COMPLETED') throw Error('EXPORT_WORKER_FAILED');
        const first = await download(v, dataset, frame, dataset.toLowerCase());
        job.csv = first.result;
        save();
        if (dataset === 'HOURLY') {
          const before = (await db('consistency-observe')).exports.find((x) => x.id === job.id);
          const changed = await db('business-inject-export-lease', {
            exportId: job.id,
            exportRequestedBy: job.requestedBy,
            faultAuthorization: 'USER_CONFIRMED_OWN_FIXTURE_ONLY_2026_10_03',
          });
          r.leaseInjection = changed.exportLease;
          ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
          save();
          const recovered = await terminal(job, 'lease-recovery');
          delete ctx.receipt.cleanupHold;
          save();
          if (recovered.status !== 'COMPLETED') throw Error('EXPIRED_LEASE_RECOVERY_FAILED');
          const after = (await db('consistency-observe')).exports.find((x) => x.id === job.id),
            second = await download(recovered, dataset, frame, 'hourly-recovered');
          r.leaseRecovery = assertLeaseRecovery(before, changed.exportLease, after, first.text, second.text);
          save();
        }
      }
      r.finalFrame = await db('consistency-observe');
      r.finalConsistency = assertConsistency(
        r.finalFrame,
        telemetry,
        r.reports,
        ctx.receipt.devices,
        ctx.receipt.customers,
      );
      r.gate = 'PASS_SCOPED_ESG_LEASE_AND_CONSISTENCY';
      save();
    } catch (e) {
      if (r.reports.some((p) => p.publish !== 'PUBACK'))
        ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
      const pending = r.jobs.at(-1),
        postCheck = ctx.receipt.checks.findLast((c) => c.id === 'close-esg:create:' + pending?.dataset);
      if (pending?.submission === 'ATTEMPTING_NO_RETRY' && [400, 401, 403, 404, 409, 422].includes(postCheck?.status)) {
        pending.submission = 'REJECTED_NO_RETRY';
        delete ctx.receipt.cleanupHold;
      }
      r.gate = 'FAIL';
      r.failure = {
        code: /^[A-Z_]{1,100}$/.test(e.message) ? e.message : 'ESG_TARGET_FAILED',
        errorName: /^[A-Za-z_]{1,80}$/.test(e.name) ? e.name : 'Error',
      };
      save();
    } finally {
      if (ctx.receipt.cleanupHold) {
        r.businessCleanup = 'BLOCKED_UNKNOWN_OR_RUNNING_WRITE';
        r.gate = 'FAIL';
        save();
      } else {
        try {
          await cleanupCompletedWrites();
        } catch {
          r.businessCleanup = 'FAIL_OR_UNKNOWN_NO_MUTATION_RETRY';
          r.gate = 'FAIL';
          const hold = cleanupFailureRequiresHold({
            lastAction: r.builds.at(-1)?.action,
            knownCleanupCommitted: r.builds.some((b) => b.action === 'business-cleanup' && b.gate === 'PASS'),
            existingHold: !!ctx.receipt.cleanupHold,
          });
          if (hold) ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
          else r.readonlyAuditFailure = 'RETAINED_FAIL_OR_UNKNOWN_NO_RESTART_RESOURCE_CLEANUP_ALLOWED';
        }
      }
      r.finishedAt = new Date().toISOString();
      save();
    }
  };
  extension.mqttPublishDeadlineMs = 45000;
  extension.beforeDeviceTelemetry = refreshOwnTelemetrySession;
  extension.onCorePublished = ({ deviceId, raw }) => {
    const p = JSON.parse(raw);
    telemetry.push({
      deviceId,
      seq: p.meta.seq,
      messageId: p.meta.id,
      occurredAt: p.meta.ts,
      data: p.data,
      bodySha256: sha256(raw),
      payloadSha256: sha256(canonical(p)),
    });
  };
  const result = await main(output, versionPath, extension);
  const child = existsSync(output + '.reliability.json')
    ? JSON.parse(readFileSync(output + '.reliability.json'))
    : null;
  return {
    parentGate: result.gate,
    gate: child?.gate ?? 'NOT_STARTED',
    businessCleanup: child?.businessCleanup ?? 'NOT_STARTED',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await runEsgCloseout(...process.argv.slice(2));
  console.log(JSON.stringify(r));
  process.exitCode =
    r.parentGate === 'PASS' && r.gate === 'PASS_SCOPED_ESG_LEASE_AND_CONSISTENCY' && r.businessCleanup === 'PASS'
      ? 0
      : 1;
}
