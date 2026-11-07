import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildHandoff, writeOrCheckHandoff, DEVICE_PREVIEW_PATHS } from './generate-device-preview-handoff.mjs';
import { createAjv } from '../contracts/testing/device-contract.ts';

const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root)));
const generated = buildHandoff(),
  doc = JSON.parse(generated['openapi.json']);
const source = read('contracts/rest/live-image-api.json');
const policy = read('contracts/domain/camera-interaction-policy.json').liveImage;
const ajv = createAjv();
ajv.addSchema(doc, 'vendor');
function expand(value, document) {
  if (Array.isArray(value)) return value.map((item) => expand(item, document));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const [file, pointer] = value.$ref.split('#');
    const target = file ? read(`contracts/rest/${file}`) : document;
    const result = pointer
      .split('/')
      .slice(1)
      .reduce((current, key) => current[key], target);
    return expand(result, target);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, document)]));
}
test('generated subset is self-contained and semantically identical to the two frozen device operations', () => {
  assert.deepEqual(Object.keys(doc.paths), DEVICE_PREVIEW_PATHS);
  for (const path of DEVICE_PREVIEW_PATHS) {
    assert.deepEqual(expand(doc.paths[path], doc), expand(source.paths[path], source));
    for (const operation of Object.values(doc.paths[path])) assert.deepEqual(operation.security, [{ DeviceMtls: [] }]);
  }
  assert.deepEqual(
    doc.components.securitySchemes.DeviceMtls,
    read('contracts/rest/openapi-base.json').components.securitySchemes.DeviceMtls,
  );
  assert.equal(JSON.stringify(doc).includes('openapi-base.json#'), false);
  assert.equal(doc.servers[0].url, 'https://device-api.example.invalid');
  assert.deepEqual(Object.keys(doc.components.securitySchemes), ['DeviceMtls']);
});
test('all response examples validate against their actual operation/status schema; codes cannot masquerade as another status', () => {
  const responses = JSON.parse(generated['responses.json']);
  for (const item of responses) {
    const operation = Object.values(doc.paths)
      .flatMap((methods) => Object.values(methods))
      .find((op) => op.operationId === item.operationId);
    const schema = operation.responses[item.status].content['application/json'].schema;
    const validate = ajv.compile({ ...doc, $ref: schema.$ref });
    assert.ok(validate(item.body), `${item.id}: ${JSON.stringify(validate.errors)}`);
    assert.equal(item.headers['Cache-Control'], 'no-store');
    if (item.status === 429) assert.match(item.headers['Retry-After'], /^[1-9]\d*$/);
  }
  const validate400 = ajv.compile({ ...doc, $ref: '#/components/schemas/LiveError400' });
  assert.equal(validate400({ error: { code: 'FRAME_CONFLICT', message: 'wrong status', requestId: 'r' } }), false);
  assert.equal(new Set(responses.map((item) => item.id)).size, responses.length);
});
test('complete JPEG/Base64 frame is valid and rejects missing stream, data URI, unknown field and wrong MIME', () => {
  const frame = JSON.parse(generated['frame-request.json']);
  const validate = ajv.compile({ ...doc, $ref: '#/components/schemas/LiveFrameCreate' });
  assert.ok(validate(frame));
  assert.deepEqual(Buffer.from(frame.imageBase64, 'base64'), generated['capture.jpg']);
  for (const bad of [
    { ...frame, streamId: undefined },
    { ...frame, imageBase64: `data:image/jpeg;base64,${frame.imageBase64}` },
    { ...frame, extra: true },
    { ...frame, mimeType: 'image/png' },
  ])
    assert.equal(validate(bad), false);
  assert.equal(policy.defaultEnabled, false);
  const active = doc.components.schemas.LiveActive.properties;
  assert.equal(active.pollIntervalMs.const, policy.pollIntervalMs);
  assert.equal(active.uploadIntervalMs.const, policy.uploadIntervalMs);
  assert.equal(active.maxImageBytes.const, policy.maxImageBytes);
  assert.equal(
    doc.components.schemas.LiveFrameCreate.properties.imageBase64.maxLength,
    4 * Math.ceil(policy.maxImageBytes / 3),
  );
});
test('freshness and hashes bind every distributed file and canonical input', () => {
  writeOrCheckHandoff(true);
  const manifest = JSON.parse(generated['manifest.json']);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  for (const file of manifest.files) {
    assert.equal(generated[file.path].length, file.bytes);
    assert.equal(sha(generated[file.path]), file.sha256);
  }
  for (const file of manifest.sourceFiles) assert.equal(sha(readFileSync(new URL(file.path, root))), file.sha256);
  assert.equal(manifest.contractVersion, source.info.version);
  assert.equal(manifest.scope, 'cloud-interface-package-only');
});
test('offline freshness command works from outside repository cwd', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('./generate-device-preview-handoff.mjs', import.meta.url).pathname, '--check'],
    { cwd: '/tmp', encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS \(offline\)/);
});
