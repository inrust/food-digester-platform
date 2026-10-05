import { assertBusinessContext } from './qa09-business-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { S3Client, ListObjectVersionsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
export async function runOwnSuperExports(ctx, output) {
  assertBusinessContext(ctx.receipt);
  const r = {
    scope: 'OWN_SUPERADMIN_ACTIVITY_ESG_EXPORTS',
    gate: 'RUNNING',
    jobs: [],
    checks: [],
    databaseBuilds: [],
    cleanup: [],
    fullQa09Accepted: false,
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  const proof = (id, ok) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
    save();
    if (!ok) throw Error('SUPER_EXPORT_ASSERTION_FAILED');
  };
  const db = async (action, baseline) => {
    const receipt = output + '.' + action + '.json';
    const result = await runFixture(
      {
        prefix: ctx.receipt.prefix,
        devices: ctx.receipt.devices,
        customers: ctx.receipt.customers,
        action,
        semanticExportIds: r.jobs.filter((x) => x.kind === 'esg').map((x) => x.id),
        ...(baseline ? { businessBaseline: baseline } : {}),
      },
      receipt,
      (p) => console.log(p),
    );
    r.databaseBuilds.push({ action, receipt, buildId: result.build.id });
    save();
    return result.result;
  };
  let baseline;
  save();
  try {
    baseline = (await db('business-baseline')).businessFingerprints;
    for (const kind of ['activity', 'esg']) {
      const path =
        kind === 'activity'
          ? '/api/v1/admin/devices/' + ctx.receipt.devices[0] + '/activities/export'
          : '/api/v1/admin/esg/exports';
      const job = (
        await ctx.api(
          'super-export-create-' + kind,
          'POST',
          path,
          202,
          kind === 'activity'
            ? {}
            : { dataset: 'HOURLY', customerId: ctx.receipt.customers[0].id, deviceId: ctx.receipt.devices[0] },
        )
      ).data;
      r.jobs.push({
        id: job.exportId,
        kind,
        role: 'PlatformSuperAdmin',
        method: 'POST',
        path,
        status: 202,
        result: 'PASS',
      });
      save();
      const read =
        kind === 'activity'
          ? '/api/v1/admin/activity-exports/' + job.exportId
          : '/api/v1/admin/esg/exports/' + job.exportId;
      let value;
      for (let n = 0; n < 48; n++) {
        value = (await ctx.api('super-export-poll-' + kind + '-' + n, 'GET', read, 200)).data;
        if (['COMPLETED', 'FAILED'].includes(value.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      proof(kind + '-completed', value.status === 'COMPLETED');
      const response = await fetch(value.downloadUrl, { signal: AbortSignal.timeout(20000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      proof(kind + '-download', response.status === 200 && bytes.length > 0 && bytes.length < 1048576);
      proof(
        kind + '-row-count',
        Number.isInteger(value.rowCount) && bytes.toString('utf8').trim().split('\n').length - 1 === value.rowCount,
      );
      writeFileSync(output + '.' + kind + '.csv', bytes);
      r.jobs.at(-1).csv = {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        rowCount: value.rowCount,
      };
      save();
    }
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.failureCode = e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'SUPER_EXPORT_FAILED');
  }
  try {
    const s3 = new S3Client({ region: 'ap-southeast-1', credentials: ctx.credentials, maxAttempts: 1 });
    for (const job of r.jobs) {
      if (!/^[a-f0-9-]{36}$/.test(job.id)) throw Error('EXPORT_SCOPE_DRIFT');
      const key = job.kind + '-exports/' + job.id + '.csv';
      const list = () =>
        s3.send(new ListObjectVersionsCommand({ Bucket: 'fdp-test-export-065986019555', Prefix: key }), {
          abortSignal: AbortSignal.timeout(30000),
        });
      const versions = await list();
      if (versions.IsTruncated) throw Error('EXPORT_VERSION_PAGE_LIMIT');
      for (const v of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].filter((v) => v.Key === key))
        await s3.send(
          new DeleteObjectCommand({ Bucket: 'fdp-test-export-065986019555', Key: key, VersionId: v.VersionId }),
          { abortSignal: AbortSignal.timeout(30000) },
        );
      const rest = await list();
      if (rest.IsTruncated || [...(rest.Versions ?? []), ...(rest.DeleteMarkers ?? [])].some((v) => v.Key === key))
        throw Error('EXPORT_OBJECT_REMAINS');
      r.cleanup.push({ key, result: 'PASS' });
      save();
    }
    if (baseline) {
      const cleaned = await db('business-cleanup', baseline);
      proof(
        'owned-business-rows-empty',
        Object.values(cleaned.counts).every((n) => n === 0),
      );
      await db('business-audit', baseline);
      r.cleanup.push({ type: 'database-and-outside-fingerprints', result: 'PASS' });
    }
  } catch (e) {
    r.gate = 'FAIL';
    r.cleanupFailure = e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'SUPER_EXPORT_CLEANUP_FAILED');
  }
  r.finishedAt = new Date().toISOString();
  save();
  return r;
}
