import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyArchiveObjects } from './qa09-recovered-archive-probe.mjs';
const [parentFile, childFile, observeFile, output] = process.argv.slice(2);
const p = JSON.parse(readFileSync(parentFile)),
  o = JSON.parse(readFileSync(observeFile));
const events = readFileSync(childFile + '.mqtt-publisher.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
const unique = [...new Map(events.filter((x) => x.event === 'publish-attempt').map((x) => [x.messageId, x])).values()];
if (
  !p.finishedAt ||
  o.gate !== 'PASS' ||
  o.result.prefix !== p.prefix ||
  o.result.action !== 'observe' ||
  o.result.sourceHash !== o.sourceHash ||
  o.result.buildId !== o.build.id ||
  o.build.status !== 'SUCCEEDED'
)
  throw Error('OBSERVATION_BINDING_REQUIRED');
const deadline = new Date(
  Math.max(...events.filter((x) => x.event === 'puback').map((x) => Date.parse(x.acknowledgedAt))) + 300000,
).toISOString();
const plan = {
  prefix: p.prefix,
  devices: p.devices,
  customers: p.customers.map((x) => x.id),
  profile: 'QA07_QUICK_REAL_MQTT',
  allowLaterOwnSloRecords: true,
  archiveDeadlineAt: deadline,
  published: [...p.published.filter((x) => x.seq < 10000), ...unique],
  outbox: o.result.outbox.filter((x) => x.rawBodySha256).map((x) => ({ id: x.id, rawBodySha256: x.rawBodySha256 })),
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const r = {
  task: 'QA-09',
  scope: 'READONLY_CLI_EXACT_ORIGINAL_950_ARCHIVE_RECOVERY',
  prefix: p.prefix,
  sourceCommit: p.sourceCommit,
  profile: 'esgiot-readonly',
  objectReadProfile: 'esgiot-infra',
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  plan,
  inputs: [parentFile, childFile, observeFile, childFile + '.mqtt-publisher.ndjson'].map((path) => ({
    path,
    sha256: sha(readFileSync(path)),
  })),
  sources: ['scripts/run-qa09-recovered-archive-local.mjs', 'scripts/qa09-recovered-archive-probe.mjs'].map((path) => ({
    path,
    sha256: sha(readFileSync(path)),
    sourceBase64: readFileSync(path).toString('base64'),
  })),
  downloaded: 0,
  cleanup: [],
  credentialsExported: false,
  kmsAndIamManagementPerformed: false,
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
const dir = mkdtempSync(join(tmpdir(), 'qa09-archive-local-'));
const run = promisify(execFile);
const aws = async (args, profile = 'esgiot-readonly') => {
  try {
    const v = await run(
      'aws',
      [...args, '--profile', profile, '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
    );
    return JSON.parse(v.stdout);
  } catch (e) {
    throw Object.assign(Error('AWS_READ_FAILED'), {
      awsAction: args.slice(0, 2).join(':'),
      awsErrorName: e.name,
      awsCode: e.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? e.code ?? 'CLI_FAILED',
    });
  }
};
try {
  const id = await aws(['sts', 'get-caller-identity']);
  if (id.Account !== '065986019555') throw Error('WRONG_ACCOUNT');
  const keys = [];
  for (const c of plan.customers)
    for (const type of ['heartbeat', 'telemetry']) {
      const prefix = `raw/topic_type=${type}/customer_id=${c}/`;
      let token;
      do {
        const page = await aws([
          's3api',
          'list-objects-v2',
          '--bucket',
          'fdp-test-raw-065986019555',
          '--prefix',
          prefix,
          '--max-keys',
          '1000',
          '--no-paginate',
          ...(token ? ['--continuation-token', token] : []),
        ]);
        for (const x of page.Contents ?? []) {
          if (!x.Key.startsWith(prefix) || !/\.(json\.gz|manifest\.json)$/.test(x.Key) || x.Size > 1048576)
            throw Error('OWN_ARCHIVE_SCOPE_REQUIRED');
          if (x.Key.endsWith('.json.gz')) keys.push(x.Key);
          else r.manifestsListed = (r.manifestsListed ?? 0) + 1;
        }
        if (keys.length > 2000) throw Error('ARCHIVE_LIMIT');
        token = page.NextContinuationToken;
      } while (token);
    }
  r.listedKeys = keys;
  r.listed = keys.length;
  save();
  const objects = [];
  let offset = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (offset < keys.length) {
        const i = offset++,
          key = keys[i],
          file = join(dir, String(i) + '.gz');
        const meta = await aws(
          ['s3api', 'get-object', '--bucket', 'fdp-test-raw-065986019555', '--key', key, file],
          'esgiot-infra',
        );
        objects.push({ key, lastModified: new Date(meta.LastModified).toISOString(), bytes: readFileSync(file) });
        r.downloaded++;
        if (r.downloaded % 50 === 0) {
          save();
          console.log('Archive objects read: ' + r.downloaded + '/' + keys.length);
        }
      }
    }),
  );
  r.result = verifyArchiveObjects(plan, objects);
  r.gate = 'PASS';
} catch (e) {
  r.gate = 'FAIL';
  r.errorCode = /^[A-Z_]+$/.test(e.message) ? e.message : 'ARCHIVE_READ_FAILED';
  r.awsCode = e.awsCode;
  r.awsErrorName = e.awsErrorName;
  r.awsAction = e.awsAction;
} finally {
  rmSync(dir, { recursive: true, force: true });
  r.cleanup.push({ type: 'ephemeral-archive-bytes-removed', result: 'PASS' });
  r.finishedAt = new Date().toISOString();
  save();
}
console.log(
  JSON.stringify({
    gate: r.gate,
    archived: r.result?.archivedMessages,
    downloaded: r.downloaded,
    errorCode: r.errorCode,
    awsCode: r.awsCode,
  }),
);
process.exitCode = r.gate === 'PASS' ? 0 : 1;
