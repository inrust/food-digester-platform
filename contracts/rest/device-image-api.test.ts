import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createAjv } from '../testing/device-contract.ts';
import type { MediaUploadSessionCreate } from './image-types.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const docs = ['openapi-base.json', 'live-image-api.json', 'device-media-api.json', 'admin-alarm-api.json'];
const ajv = createAjv();
for (const name of docs) ajv.addSchema(read('./' + name), name);
const fixture = './fixtures/device-images/';

test('all positive and negative P0 schema vectors, including legacy requests', () => {
  const cases = read(fixture + 'cases.json');
  for (const entry of cases) {
    const validate = ajv.compile({ $ref: `${entry.document}#/components/schemas/${entry.schema}` });
    assert.equal(validate(entry.value), entry.valid, `${entry.schema}: ${JSON.stringify(validate.errors)}`);
  }
  const validate = ajv.compile({ $ref: 'device-media-api.json#/components/schemas/MediaUploadSessionSuccess' });
  assert.ok(validate(read(fixture + 'session-response.json')), JSON.stringify(validate.errors));
});

test('five routes declare authentication, response shapes and no-store', () => {
  const doc = read('./live-image-api.json');
  const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.values(methods as Record<string, any>).map((operation: any) => ({ path, operation })),
  );
  assert.equal(operations.length, 5);
  for (const { path, operation } of operations) {
    assert.deepEqual(operation.security, [{ [path.includes('/admin/') ? 'CognitoJwt' : 'DeviceMtls']: [] }]);
    const response = operation.responses['200'] ?? operation.responses['204'];
    assert.equal(response.headers['Cache-Control'].schema.const, 'no-store');
    assert.ok(operation.responses['401']);
    assert.ok(operation.responses['403']);
    assert.ok(operation.responses['409']);
  }
});

test('binary JPEG, Base64, size and S3 checksum match the supplied sample', () => {
  const image = readFileSync(new URL(fixture + 'capture.jpg', import.meta.url));
  const manifest = read(fixture + 'manifest.json');
  const frame = read(fixture + 'frame-request.json');
  assert.deepEqual(Buffer.from(frame.imageBase64, 'base64'), image);
  assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(image.subarray(-2).toString('hex'), 'ffd9');
  assert.equal(image.length, manifest.sizeBytes);
  const hash = createHash('sha256').update(image).digest();
  assert.equal(hash.toString('hex'), manifest.sha256);
  assert.equal(hash.toString('base64'), manifest.checksumSha256Base64);
  for (const file of ['legacy-upload-request.json', 'alarm-upload-request.json', 'event-upload-request.json']) {
    const request = read(fixture + file);
    assert.equal(request.sha256, manifest.sha256);
    assert.equal(request.sizeBytes, image.length);
    assert.equal(request.sizeKb, Math.ceil(image.length / 1024));
  }
});

test('old Alarm and Event fields remain optional-extension compatible', () => {
  const doc = read('./admin-alarm-api.json');
  for (const name of ['Alarm', 'DeviceEvent']) {
    const schema = doc.components.schemas[name];
    assert.ok(!schema.required.includes('evidenceImage'));
    const validate = ajv.compile(
      schema.properties.evidenceImage.$ref
        ? schema.properties.evidenceImage
        : {
            ...doc,
            $ref: `#/components/schemas/${name}/properties/evidenceImage`,
          },
    );
    assert.ok(validate(null));
    for (const status of ['AVAILABLE', 'DELETED']) {
      assert.ok(validate({ mediaId: 'M1', captureTime: '2026-11-06T08:00:00Z', status }));
    }
  }
});

test('prior request and session success remain valid under both published baselines', () => {
  const before = read('../testing/baselines/0.15.0.json').rest.createMediaUploadSession;
  const oldRequest: MediaUploadSessionCreate = read(fixture + 'legacy-upload-request.json');
  assert.ok(ajv.compile(before.request.body.content['application/json'].schema)(oldRequest));
  const response = read(fixture + 'session-response.json');
  delete response.data.triggerRef;
  assert.ok(ajv.compile(before.responses['201'].content['application/json'].schema)(response));
  assert.ok(ajv.compile({ $ref: 'device-media-api.json#/components/schemas/MediaUploadSessionSuccess' })(response));
});

test('normal contract validator accepts scoped domain errors and rejects wrong status', async () => {
  const { deviceContract: contract } = await import('../testing/device-contract.ts');
  const error = { error: { code: 'FRAME_CONFLICT', message: 'Frame differs', requestId: 'sample' } };
  contract.assertResponse('uploadDeviceLiveImageFrame', { status: 409, body: error });
  assert.throws(() => contract.assertResponse('uploadDeviceLiveImageFrame', { status: 400, body: error }));
  contract.assertResponse('createMediaUploadSession', {
    status: 409,
    body: {
      error: {
        code: 'MEDIA_ALREADY_REGISTERED',
        message: 'Registered',
        requestId: 'sample',
        details: { mediaId: 'M1' },
      },
    },
  });
});

test('all five operations accept positive wire inputs and reject negative ones', () => {
  const doc = read('./live-image-api.json');
  const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods as Record<string, any>));
  for (const entry of read(fixture + 'request-cases.json')) {
    const operation: any = operations.find((value: any) => value.operationId === entry.operationId);
    assert.ok(operation);
    const errors: string[] = [];
    for (const parameter of operation.parameters ?? []) {
      const value = entry[parameter.in === 'path' ? 'params' : 'query']?.[parameter.name];
      if (value === undefined) {
        if (parameter.required) errors.push('missing parameter');
      } else if (!ajv.compile(parameter.schema)(value)) errors.push('invalid parameter');
    }
    if (operation.requestBody) {
      const schema = operation.requestBody.content['application/json'].schema;
      if (!ajv.compile({ ...doc, $ref: schema.$ref })(entry.body)) errors.push('body');
    } else if (entry.body !== undefined) errors.push('body forbidden');
    assert.equal(errors.length === 0, entry.valid, entry.operationId);
  }
  const maximumFrame = read(fixture + 'frame-request.json');
  maximumFrame.imageBase64 = Buffer.alloc(131072).toString('base64');
  assert.ok(Buffer.byteLength(JSON.stringify(maximumFrame)) < 184320);
});
