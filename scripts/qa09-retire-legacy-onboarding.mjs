import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DB_TARGET } from './qa09-db-readonly-probe.mjs';
export const RETIREMENT_PROJECT = 'fdp-test-qa09-legacy-retirement';
export const ALLOWED = [
  {
    request_id: '7770dfbb-84f1-4a07-b37a-d45e1d752e65',
    job_id: '9fe0a5c6-fb65-410d-8e3a-be7b8021935d',
    device_id: 'fdp-e2e-mub39wna',
    issued_certificate_id: 'eca914431b0db2d444d850cc71c60036ea9096342fd6d301f6f4ab44fa5f9de5',
  },
  {
    request_id: 'a7702a52-1fab-4aed-ab8e-022a8135f769',
    job_id: 'fb159fec-d372-42b4-a65d-290b5b609cbe',
    device_id: 'fdp-singleca-5672423e',
    issued_certificate_id: '2b0ef8b2675da8741dad1167d5e4c803de8391af59511adc3d78eb5b63799cc0',
  },
];
export function validateApproval(plan) {
  if (
    plan.status !== 'APPROVED' ||
    plan.accountId !== DB_TARGET.accountId ||
    plan.region !== DB_TARGET.region ||
    plan.database !== DB_TARGET.database ||
    plan.sourceCommit !== 'f63b56ed39ce99deb4b0177df9afcde386dd30df' ||
    plan.artifact?.zipSha256 !== '95773c88cb17c0de4b3bb1adea3dba74151f132887e0f2fbe9739c20da03fe55'
  )
    throw Error('UNAPPROVED_RETIREMENT');
  const s = plan.snapshot;
  if (
    s?.Status !== 'available' ||
    s.Encrypted !== true ||
    s.DBInstanceIdentifier !== 'fdp-test-db' ||
    s.SnapshotType !== 'manual' ||
    !s.DBSnapshotArn?.startsWith('arn:aws:rds:ap-southeast-1:065986019555:snapshot:fdp-test-qa09-pre-csr-20261002-')
  )
    throw Error('RECOVERABLE_SNAPSHOT_REQUIRED');
  if (
    plan.requestAndJobWhitelist?.length !== 2 ||
    ALLOWED.some((r, i) => Object.entries(r).some(([k, v]) => plan.requestAndJobWhitelist[i]?.[k] !== v))
  )
    throw Error('WHITELIST_DRIFT');
}
async function fingerprints(client, tables) {
  const result = {};
  for (const table of tables) {
    if (!/^[_a-z][_a-z0-9]*$/.test(table)) throw Error('UNSAFE_TABLE');
    result[table] = (
      await client.query(
        `SELECT count(*)::text AS count, md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text),'')) AS digest FROM public."${table}" t`,
      )
    ).rows[0];
  }
  return result;
}
export async function retireLegacy(client, plan) {
  validateApproval(plan);
  let committed = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== DB_TARGET.database)
      throw Error('WRONG_DATABASE');
    await client.query(
      'LOCK TABLE public.onboarding_requests, public.onboarding_provisioning_jobs IN SHARE ROW EXCLUSIVE MODE',
    );
    const actual = (
      await client.query(
        'SELECT r.id AS request_id, r.status AS request_status, j.id AS job_id, j.status AS job_status, d.id AS device_id, d.lifecycle_status AS device_status, j.issued_certificate_id FROM public.onboarding_requests r LEFT JOIN public.onboarding_provisioning_jobs j ON j.request_id = r.id LEFT JOIN public.devices d ON d.serial_number = r.serial_number ORDER BY r.id',
      )
    ).rows;
    if (
      actual.length !== 2 ||
      ALLOWED.some(
        (expected, i) =>
          Object.entries(expected).some(([k, v]) => actual[i]?.[k] !== v) ||
          actual[i].request_status !== 'APPROVED' ||
          actual[i].job_status !== 'COMPLETED' ||
          actual[i].device_status !== 'Onboarded',
      )
    )
      throw Error('LIVE_WHITELIST_OR_STATE_DRIFT');
    const jobs = (await client.query('SELECT count(*)::text AS count FROM public.onboarding_provisioning_jobs')).rows[0]
      .count;
    if (jobs !== '2') throw Error('UNEXPECTED_JOBS');
    const tables = (
      await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows
      .map((r) => r.tablename)
      .filter((t) => !['onboarding_requests', 'onboarding_provisioning_jobs'].includes(t));
    const before = await fingerprints(client, tables);
    const certificateIdentityRows = (
      await client.query('SELECT id, device_id, fingerprint, status FROM public.device_certificates ORDER BY id')
    ).rows;
    const jobResult = await client.query(
      "DELETE FROM public.onboarding_provisioning_jobs WHERE id = ANY($1::text[]) AND request_id = ANY($2::text[]) AND status = 'COMPLETED' RETURNING id",
      [ALLOWED.map((r) => r.job_id), ALLOWED.map((r) => r.request_id)],
    );
    if (jobResult.rowCount !== 2) throw Error('JOB_DELETE_COUNT_MISMATCH');
    const requestResult = await client.query(
      "DELETE FROM public.onboarding_requests WHERE id = ANY($1::text[]) AND status = 'APPROVED' RETURNING id",
      [ALLOWED.map((r) => r.request_id)],
    );
    if (requestResult.rowCount !== 2) throw Error('REQUEST_DELETE_COUNT_MISMATCH');
    const after = await fingerprints(client, tables);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('PRESERVED_DATA_CHANGED');
    await client.query('COMMIT');
    committed = true;
    return {
      deletedRequests: requestResult.rows.map((r) => r.id).sort(),
      deletedJobs: jobResult.rows.map((r) => r.id).sort(),
      preservedTables: after,
      certificateIdentityRows,
      remainingLegacyRequests: 0,
      snapshotArn: plan.snapshot.DBSnapshotArn,
    };
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}
function aws(args) {
  const r = spawnSync('aws', [...args, '--region', DB_TARGET.region, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0) throw Error('AWS_READ_FAILED');
  return JSON.parse(r.stdout);
}
async function main() {
  const id = aws(['sts', 'get-caller-identity']);
  if (
    id.Account !== DB_TARGET.accountId ||
    !id.Arn?.startsWith(`arn:aws:sts::${DB_TARGET.accountId}:assumed-role/fdp-test-migration-runner-role/`) ||
    !process.env.CODEBUILD_BUILD_ID?.startsWith(RETIREMENT_PROJECT + ':') ||
    process.env.DB_SECRET_ARN !== DB_TARGET.secretArn
  )
    throw Error('WRONG_RETIREMENT_RUNNER');
  const source = readFileSync(new URL(import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== process.env.QA09_RETIREMENT_SHA256)
    throw Error('EXECUTED_SOURCE_MISMATCH');
  if (
    createHash('sha256')
      .update(readFileSync(new URL('./qa09-db-readonly-probe.mjs', import.meta.url)))
      .digest('hex') !== process.env.QA09_QUERY_MODULE_SHA256
  )
    throw Error('QUERY_MODULE_HASH_MISMATCH');
  const plan = JSON.parse(Buffer.from(process.env.QA09_RETIREMENT_APPROVAL_B64 ?? '', 'base64').toString());
  validateApproval(plan);
  const secret = JSON.parse(
    aws(['secretsmanager', 'get-secret-value', '--secret-id', DB_TARGET.secretArn]).SecretString,
  );
  if (secret.host !== DB_TARGET.host || secret.dbname !== DB_TARGET.database || (secret.port ?? 5432) !== 5432)
    throw Error('WRONG_DATABASE_SECRET');
  const { Client } = createRequire(resolve('package.json'))('pg');
  const client = new Client({
    host: secret.host,
    port: 5432,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    connectionTimeoutMillis: 10000,
    ssl: { ca: readFileSync('rds-ca-bundle.pem', 'utf8'), rejectUnauthorized: true },
  });
  try {
    await client.connect();
    const result = await retireLegacy(client, plan);
    console.log(
      JSON.stringify({
        kind: 'fdp-qa09-legacy-retirement/v1',
        executedAt: new Date().toISOString(),
        sourceCommit: plan.sourceCommit,
        executorSha256: process.env.QA09_RETIREMENT_SHA256,
        buildId: process.env.CODEBUILD_BUILD_ID,
        gate: 'PASS',
        ...result,
      }),
    );
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        kind: 'fdp-qa09-legacy-retirement-failure/v1',
        code: /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : 'RETIREMENT_FAILED',
      }),
    );
    process.exitCode = 1;
  });
