import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArchiveHandoff, writeOrCheckArchive } from './generate-device-archive-handoff.mjs';
import { subsetOpenApi } from './cloud-handoff-openapi.mjs';
import { createAjv } from '../contracts/testing/device-contract.ts';
const root = new URL('../', import.meta.url),
  read = (path) => JSON.parse(readFileSync(new URL(path, root)));
const files = buildArchiveHandoff(),
  doc = JSON.parse(files['openapi.json']),
  responses = JSON.parse(files['responses.json']);
const ajv = createAjv();
const validate = (name, value) => {
  const check = ajv.compile({ ...doc, $ref: `#/components/schemas/${name}` });
  assert.ok(check(value), JSON.stringify(check.errors));
};
function expand(value, context) {
  if (Array.isArray(value)) return value.map((item) => expand(item, context));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const [file, pointer] = value.$ref.split('#');
    const target = file ? read(`contracts/rest/${file}`) : context;
    return expand(
      pointer
        .split('/')
        .slice(1)
        .reduce((current, key) => current[key], target),
      target,
    );
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, context)]));
}
test('standalone upload-session operation retains source auth, all statuses and conditional IMAGE rule', () => {
  const source = read('contracts/rest/device-media-api.json');
  assert.deepEqual(Object.keys(doc.paths), ['/api/v1/device/media/upload-sessions']);
  assert.deepEqual(expand(doc.paths, doc), expand(source.paths, source));
  assert.deepEqual(doc.paths['/api/v1/device/media/upload-sessions'].post.security, [{ DeviceMtls: [] }]);
  assert.deepEqual(Object.keys(doc.components.securitySchemes), ['DeviceMtls']);
  assert.equal(JSON.stringify(doc).includes('openapi-base.json#'), false);
  const check = ajv.compile({ ...doc, $ref: '#/components/schemas/MediaUploadSessionCreate' }),
    req = JSON.parse(files['alarm-upload-request.json']);
  for (const bad of [
    { ...req, mediaType: 'VIDEO' },
    { ...req, triggerRef: null },
    { ...req, triggerRef: { ...req.triggerRef, extra: true } },
    { ...req, triggerRef: { ...req.triggerRef, messageId: 'illegal_id' } },
    { ...req, objectPath: 'client/key' },
  ])
    assert.equal(check(bad), false);
});
test('15 actual HTTP response examples validate; registration requires mediaId, quota and trigger conflict stay distinct', () => {
  const operation = doc.paths['/api/v1/device/media/upload-sessions'].post;
  assert.equal(responses.length, 15);
  for (const entry of responses) {
    assert.ok(operation.responses[entry.status]);
    const check = ajv.compile(
      expand(expand(operation.responses[entry.status], doc).content['application/json'].schema, doc),
    );
    assert.ok(check(entry.body), `${entry.id}: ${JSON.stringify(check.errors)}`);
  }
  const check = ajv.compile({ ...doc, $ref: '#/components/schemas/MediaAlreadyRegistered' });
  assert.equal(check({ error: { code: 'MEDIA_ALREADY_REGISTERED', message: 'registered', requestId: 'r' } }), false);
  assert.equal(responses.find((r) => r.id === 'conflict').body.error.details, undefined);
  assert.equal(responses.find((r) => r.id === 'media_trigger_conflict').body.error.details, undefined);
});
test('reused sessions preserve immutable identity/deadline and expiry replacements use new object keys', () => {
  for (const slug of ['alarm', 'event']) {
    const req = JSON.parse(files[`${slug}-upload-request.json`]);
    validate('MediaUploadSessionCreate', req);
    const original = responses.find((r) => r.id === `${slug}-created`).body.data,
      reused = responses.find((r) => r.id === `${slug}-reused`).body.data,
      replaced = responses.find((r) => r.id === `${slug}-expired-new`).body.data;
    for (const key of [
      'sessionId',
      'fileName',
      'mediaType',
      'sizeBytes',
      'sizeKb',
      'objectPath',
      'createdAt',
      'uploadUrlExpiresAt',
    ])
      assert.equal(reused[key], original[key]);
    assert.deepEqual(reused.triggerRef, req.triggerRef);
    assert.notEqual(reused.uploadUrl, original.uploadUrl);
    assert.notEqual(replaced.objectPath, original.objectPath);
    assert.notEqual(replaced.sessionId, original.sessionId);
    assert.deepEqual(replaced.triggerRef, req.triggerRef);
    assert.ok(Date.parse(replaced.createdAt) > Date.parse(original.uploadUrlExpiresAt));
    for (const row of [original, reused, replaced]) {
      const url = new URL(row.uploadUrl);
      const date = url.searchParams
        .get('X-Amz-Date')
        .replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
      assert.ok(
        Date.parse(date) + Number(url.searchParams.get('X-Amz-Expires')) * 1000 <= Date.parse(row.uploadUrlExpiresAt),
      );
    }
  }
  const legacy = JSON.parse(files['legacy-upload-request.json']);
  validate('MediaUploadSessionCreate', legacy);
  assert.equal(Object.hasOwn(legacy, 'triggerRef'), false);
  assert.equal(Object.hasOwn(responses.find((r) => r.id === 'legacy-created').body.data, 'triggerRef'), false);
});
test('MQTT trigger/media/replacement messages satisfy bundled frozen schemas and link to the exact request/session', () => {
  const schemas = JSON.parse(files['mqtt-schemas.json']),
    mqttAjv = createAjv();
  for (const [name, schema] of Object.entries(schemas)) mqttAjv.addSchema(schema, name);
  for (const slug of ['alarm', 'event']) {
    const workflow = JSON.parse(files[`${slug}-mqtt.json`]),
      req = JSON.parse(files[`${slug}-upload-request.json`]);
    for (const [key, type] of [
      ['trigger', slug],
      ['media', 'media'],
      ['replacementMedia', 'media'],
    ]) {
      const row = workflow[key],
        check = mqttAjv.compile({ $ref: `${type}.schema.json` });
      assert.ok(check(row.payload), JSON.stringify(check.errors));
      assert.equal(row.topic, `bnx/device/DEV001/${type}`);
      assert.equal(row.qos, 1);
    }
    assert.equal(workflow.trigger.payload.meta.id, req.triggerRef.messageId);
    assert.equal(workflow.media.payload.data.triggerRef, undefined);
    if (slug === 'alarm') {
      assert.equal(workflow.trigger.payload.data.status, 'ACTIVE');
      const clear = mqttAjv.compile({ $ref: 'alarm.schema.json' });
      assert.ok(clear(workflow.cleared.payload));
      assert.equal(workflow.cleared.payload.data.status, 'CLEARED');
      assert.notEqual(workflow.cleared.payload.meta.id, req.triggerRef.messageId);
    } else assert.ok(workflow.trigger.payload.data.eventType);
    for (const [key, suffix] of [
      ['media', 'created'],
      ['replacementMedia', 'expired-new'],
    ]) {
      const session = responses.find((r) => r.id === `${slug}-${suffix}`).body.data;
      for (const field of ['mediaType', 'fileName', 'sizeKb', 'objectPath'])
        assert.equal(workflow[key].payload.data[field], session[field]);
    }
    assert.notEqual(workflow.media.payload.meta.id, workflow.replacementMedia.payload.meta.id);
    assert.ok(workflow.replacementMedia.payload.meta.seq > workflow.media.payload.meta.seq);
    assert.equal(workflow.media.payload.data.captureTime, workflow.replacementMedia.payload.data.captureTime);
    const check = mqttAjv.compile({ $ref: 'media.schema.json' });
    assert.equal(
      check({ ...workflow.media.payload, data: { ...workflow.media.payload.data, triggerRef: req.triggerRef } }),
      false,
    );
  }
});
test('S3 examples bind exact binary length/hash and both checksum placements without invented Authorization', () => {
  const example = JSON.parse(files['s3-put-examples.json']),
    jpeg = files['capture.jpg'],
    hash = createHash('sha256').update(jpeg).digest(),
    sha = hash.toString('hex'),
    checksum = hash.toString('base64');
  assert.equal(example.signatureUsable, false);
  for (const name of ['queryChecksum', 'headerChecksum']) {
    const put = example[name],
      url = new URL(put.url);
    assert.equal(put.method, 'PUT');
    assert.equal(url.hostname, 'archive.example.invalid');
    assert.equal(put.headers['Content-Length'], String(jpeg.length));
    assert.equal(put.bodyFile, 'capture.jpg');
    assert.equal(put.headers.Authorization, undefined);
    for (const header of url.searchParams.get('X-Amz-SignedHeaders').split(';'))
      assert.ok(header === 'host' || Object.keys(put.headers).some((name) => name.toLowerCase() === header));
    assert.equal(
      name === 'queryChecksum' ? url.searchParams.get('x-amz-checksum-sha256') : put.headers['x-amz-checksum-sha256'],
      checksum,
    );
  }
  for (const slug of ['event', 'alarm']) {
    const req = JSON.parse(files[`${slug}-upload-request.json`]);
    assert.equal(req.sha256, sha);
    assert.equal(req.sizeBytes, jpeg.length);
    assert.equal(req.sizeKb, Math.ceil(jpeg.length / 1024));
  }
});
test('hash/freshness cover all portable files and policy; generated export is cwd independent', () => {
  writeOrCheckArchive(true);
  const manifest = JSON.parse(files['manifest.json']);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  for (const file of manifest.files) {
    assert.equal(sha(files[file.path]), file.sha256);
    assert.equal(files[file.path].length, file.bytes);
  }
  for (const source of manifest.sourceFiles) assert.equal(sha(readFileSync(new URL(source.path, root))), source.sha256);
  assert.equal(manifest.policy.dailyUploadQuotaPerDevice, 100);
  assert.equal(manifest.policy.uploadUrlTtlSeconds, 900);
  assert.equal(manifest.policy.maxSizeKb.IMAGE, 10240);
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./generate-device-archive-handoff.mjs', import.meta.url)), '--check'],
    { cwd: '/tmp', encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
});
test('shared subset rejects missing paths/refs, ambiguous names and unsupported references', () => {
  const rootDoc = {
    paths: {
      '/test': {
        get: {
          responses: { 200: { $ref: 'a.json#/components/schemas/S' }, 400: { $ref: 'b.json#/components/schemas/S' } },
        },
      },
    },
    components: {},
  };
  const document = { components: { schemas: { S: { type: 'string' } } } };
  assert.throws(
    () =>
      subsetOpenApi({
        document: rootDoc,
        documents: { 'a.json': document, 'b.json': structuredClone(document) },
        paths: ['/test'],
        securitySchemes: [],
      }),
    /AMBIGUOUS/,
  );
  assert.throws(
    () => subsetOpenApi({ document: rootDoc, documents: {}, paths: ['/missing'], securitySchemes: [] }),
    /MISSING_HANDOFF_PATH/,
  );
  assert.throws(
    () => subsetOpenApi({ document: rootDoc, documents: {}, paths: ['/test'], securitySchemes: [] }),
    /MISSING_HANDOFF_REF/,
  );
  const unsupported = structuredClone(rootDoc);
  unsupported.paths['/test'].get.responses[200].$ref = 'https://example.invalid/remote';
  assert.throws(
    () => subsetOpenApi({ document: unsupported, documents: {}, paths: ['/test'], securitySchemes: [] }),
    /UNSUPPORTED_HANDOFF_REF/,
  );
});
