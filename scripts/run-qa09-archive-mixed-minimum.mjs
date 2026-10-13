import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { callOwnS3Cli } from './qa09-own-s3-cli.mjs';
import { readOwnVersions } from './qa09-own-version-reader.mjs';
import { sha256, assertPartialBatch, logRows } from './qa09-minimum-a5-proof.mjs';
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
const exec = promisify(execFile),
  dir = process.argv[2] ?? 'build/qa09-private-a5-minimum-20261013/',
  prefix = 'qa09-' + randomBytes(8).toString('hex'),
  ids = [randomUUID(), randomUUID()],
  eventId = randomUUID(),
  time = new Date().toISOString(),
  bucket = 'fdp-test-raw-065986019555';
const r = {
  scope: 'DIRECT_ARCHIVE_NAMESPACE_ONLY_READ_AUTHORITY_PREFLIGHT_NO_DB_OR_MQTT_CLAIM',
  prefix,
  customerIds: ids,
  eventId,
  gate: 'RUNNING',
  cleanup: [],
  startedAt: time,
};
if (existsSync(dir + 'mixed-minimum.json')) throw Error('FRESH_MIXED_OUTPUT_DIRECTORY_REQUIRED');
const save = () => writeFileSync(dir + 'mixed-minimum.json', JSON.stringify(r, null, 2) + '\n');
save();
const aws = async (args) =>
  JSON.parse(
    (
      await exec(
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
          '5',
          '--cli-read-timeout',
          '30',
        ],
        { timeout: 45000, maxBuffer: 1048576, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
      )
    ).stdout || '{}',
  );
let attempted = false;
try {
  const pre = callOwnS3Cli(
    'list-object-versions',
    { Bucket: bucket, Prefix: `raw/topic_type=ack/customer_id=${ids[0]}/` },
    ids,
  );
  if (pre.Versions?.length || pre.DeleteMarkers?.length || pre.IsTruncated) throw Error('NONEMPTY_NAMESPACE');
  const good = {
    eventId,
    eventType: 'ARCHIVE',
    aggregateType: 'device',
    aggregateId: prefix + '-01',
    createdAt: time,
    payload: {
      archiveClass: 'MQTT_RAW',
      envelopeVersion: '1.0',
      topicType: 'ack',
      customerId: ids[0],
      deviceId: prefix + '-01',
      occurredAt: time,
      rawBody: '{}',
      payload: { meta: { id: 'DIRECT-PREFLIGHT', seq: 1, ts: time, schemaVer: '1.0' }, data: {} },
    },
  };
  const goodIds = ['DIRECT-GOOD-' + randomUUID(), 'DIRECT-DUPLICATE-' + randomUUID()],
    badIds = ['DIRECT-BAD-JSON-' + randomUUID(), 'DIRECT-BAD-ENVELOPE-' + randomUUID()],
    badEventId = randomUUID();
  r.goodIds = goodIds;
  r.badIds = badIds;
  r.badEventId = badEventId;
  r.applicationCommit = JSON.parse(readFileSync(dir + 'application-version.json')).sourceCommit;
  writeFileSync(
    dir + 'mixed-minimum.input.json',
    JSON.stringify({
      Records: [
        { messageId: goodIds[0], body: JSON.stringify(good) },
        { messageId: badIds[0], body: '{' },
        {
          messageId: badIds[1],
          body: JSON.stringify({
            ...good,
            eventId: badEventId,
            payload: { ...good.payload, topicType: 'INVALID_QA09_TYPE' },
          }),
        },
        { messageId: goodIds[1], body: JSON.stringify(good) },
      ],
    }),
  );
  r.inputSha256 = sha256(readFileSync(dir + 'mixed-minimum.input.json'));
  attempted = true;
  save();
  r.invoke = await aws([
    'lambda',
    'invoke',
    '--function-name',
    'fdp-test-archive',
    '--log-type',
    'Tail',
    '--payload',
    'fileb://' + dir + 'mixed-minimum.input.json',
    dir + 'mixed-minimum.response.json',
  ]);
  if (r.invoke.StatusCode !== 200 || r.invoke.FunctionError) throw Error('DIRECT_INVOKE_FAILED');
  r.response = JSON.parse(readFileSync(dir + 'mixed-minimum.response.json'));
  r.partialProof = assertPartialBatch(r.response, badIds, goodIds);
  r.directLogs = logRows(
    Buffer.from(r.invoke.LogResult ?? '', 'base64')
      .toString()
      .split('\n')
      .map((message) => ({ message })),
  );
  const page = callOwnS3Cli(
    'list-object-versions',
    { Bucket: bucket, Prefix: `raw/topic_type=ack/customer_id=${ids[0]}/` },
    ids,
  );
  const objects = page.Versions?.filter((v) => v.IsLatest).map((v) => ({ key: v.Key, versionId: v.VersionId }));
  if (page.IsTruncated || objects?.length !== 2) throw Error('EXPECTED_PAIR');
  r.readerReceipt = dir + 'mixed-minimum.reader.json';
  save();
  const reader = await readOwnVersions({ prefix, customerIds: ids, objects }, r.readerReceipt);
  const archive = reader.result.objects.find((o) => o.key.endsWith('.gz')),
    manifest = reader.result.objects.find((o) => o.key.endsWith('.manifest.json')),
    bytes = Buffer.from(archive.bodyBase64, 'base64'),
    m = JSON.parse(Buffer.from(manifest.bodyBase64, 'base64')),
    row = JSON.parse(gunzipSync(bytes).toString().trim());
  if (m.sha256 !== sha256(bytes) || row.eventId !== eventId || m.eventIds[0] !== eventId) throw Error('BYTES_BINDING');
  r.object = {
    key: archive.key,
    manifestKey: manifest.key,
    versionId: archive.versionId,
    manifestVersionId: manifest.versionId,
    compressedSha256: sha256(bytes),
    manifestSha256: sha256(Buffer.from(manifest.bodyBase64, 'base64')),
    eventId: row.eventId,
  };
  r.gate = 'PASS_REAL_MIXED_HANDLER_AND_GET_OBJECT_READBACK';
  save();
} catch (e) {
  r.gate = 'FAIL';
  r.failure = /^[A-Z_]+$/.test(e.message) ? e.message : 'PREFLIGHT_FAILED';
  save();
} finally {
  if (attempted) {
    try {
      const prefix = `raw/topic_type=ack/customer_id=${ids[0]}/`;
      const page = callOwnS3Cli('list-object-versions', { Bucket: bucket, Prefix: prefix }, ids);
      const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
      demand(!page.IsTruncated, 'TRUNCATED');
      if (versions.length)
        callOwnS3Cli(
          'delete-objects',
          { Bucket: bucket, Delete: { Objects: versions.map((v) => ({ Key: v.Key, VersionId: v.VersionId })) } },
          ids,
        );
      const empty = callOwnS3Cli('list-object-versions', { Bucket: bucket, Prefix: prefix }, ids);
      demand(!empty.Versions?.length && !empty.DeleteMarkers?.length && !empty.IsTruncated, 'NOT_EMPTY');
      r.cleanup.push({ type: 'own-preflight-object-versions-empty', result: 'PASS', deleted: versions.length });
    } catch {
      r.cleanup.push({ type: 'own-preflight-object-versions-empty', result: 'FAIL' });
      r.gate = 'FAIL';
    }
  }
  r.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ gate: r.gate, cleanup: r.cleanup }));
}
