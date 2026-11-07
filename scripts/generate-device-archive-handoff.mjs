#!/usr/bin/env node
/** Offline archive examples. S3 URL signatures are deliberately unusable illustrations. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { subsetOpenApi } from './cloud-handoff-openapi.mjs';
const root = new URL('../', import.meta.url);
const sources = [
  'contracts/rest/device-media-api.json',
  'contracts/rest/openapi-base.json',
  'contracts/media/media-upload-policy.json',
  'contracts/rest/fixtures/device-images/capture.jpg',
  'contracts/rest/fixtures/device-images/event-upload-request.json',
  'contracts/rest/fixtures/device-images/alarm-upload-request.json',
  'contracts/mqtt/schemas/common.schema.json',
  'contracts/mqtt/schemas/event.schema.json',
  'contracts/mqtt/schemas/alarm.schema.json',
  'contracts/mqtt/schemas/media.schema.json',
  'packages/aws-clients/src/s3-media-url-signer.ts',
  'contracts/rest/fixtures/device-images/legacy-upload-request.json',
];
const bytes = (path) => readFileSync(new URL(path, root));
const read = (path) => JSON.parse(bytes(path));
const sha = (value) => createHash('sha256').update(value).digest('hex');
export function buildArchiveHandoff() {
  const media = read(sources[0]),
    base = read(sources[1]),
    policy = read(sources[2]);
  const subset = subsetOpenApi({
    document: media,
    documents: { 'device-media-api.json': media, 'openapi-base.json': base },
    paths: ['/api/v1/device/media/upload-sessions'],
    securitySchemes: ['DeviceMtls'],
  });
  const clock = '2026-11-06T08:00:00.000Z',
    ms = Date.parse(clock),
    at = (seconds) => new Date(ms + seconds * 1000).toISOString();
  const files = {},
    json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  files['openapi.json'] = json({
    ...media,
    info: {
      ...media.info,
      title: 'Device Event/Alarm Archive - Cloud Handoff',
      description:
        'Generated frozen upload-session contract. S3 PUT and MQTT are documented separately. No device registration-result endpoint or per-message business ACK topic is added.',
      'x-delivery-scope': 'cloud-interface-package',
    },
    servers: [
      {
        url: 'https://device-api.example.invalid',
        description: 'Example only; confirm the actual environment separately.',
      },
    ],
    ...subset,
  });
  files['capture.jpg'] = bytes(sources[3]);
  const checksum = Buffer.from(sha(files['capture.jpg']), 'hex').toString('base64');
  const schemas = Object.fromEntries(
    ['common', 'event', 'alarm', 'media'].map((name) => [
      `${name}.schema.json`,
      read(`contracts/mqtt/schemas/${name}.schema.json`),
    ]),
  );
  files['mqtt-schemas.json'] = json(schemas);
  function url(key, signedAt, remaining, headerChecksum = false) {
    const result = new URL(`https://archive.example.invalid/${key}`);
    for (const [name, value] of Object.entries({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': 'EXAMPLE-NOT-A-CREDENTIAL/20261106/us-east-1/s3/aws4_request',
      'X-Amz-Date': signedAt.replace(/[-:]/g, '').replace('.000', ''),
      'X-Amz-Expires': String(remaining),
      'X-Amz-SignedHeaders': headerChecksum ? 'content-length;host;x-amz-checksum-sha256' : 'content-length;host',
      ...(!headerChecksum ? { 'x-amz-checksum-sha256': checksum } : {}),
      'X-Amz-Signature': 'EXAMPLE-NOT-A-VALID-SIGNATURE',
    }))
      result.searchParams.set(name, value);
    return result.href;
  }
  const meta = (seconds = 0) => ({ requestId: 'sample-archive', timestamp: at(seconds) });
  const rows = [];
  for (const kind of ['EVENT', 'ALARM']) {
    const slug = kind.toLowerCase(),
      req = read(`contracts/rest/fixtures/device-images/${slug}-upload-request.json`);
    files[`${slug}-upload-request.json`] = json(req);
    const key = `media/CUS001/DEV001/${kind}-SESSION-001/${req.fileName}`;
    const view = {
      sessionId: `${kind}-SESSION-001`,
      mediaType: req.mediaType,
      fileName: req.fileName,
      sizeKb: req.sizeKb,
      sizeBytes: req.sizeBytes,
      objectPath: key,
      uploadUrl: url(key, clock, 900),
      uploadUrlExpiresAt: at(900),
      createdAt: clock,
      triggerRef: req.triggerRef,
    };
    const response = (id, status, data, seconds = 0) => ({
      id: `${slug}-${id}`,
      operationId: 'createMediaUploadSession',
      status,
      body: { data, meta: meta(seconds) },
    });
    rows.push(response('created', 201, view));
    rows.push(response('reused', 200, { ...view, uploadUrl: url(key, at(300), 600) }, 300));
    const newKey = `media/CUS001/DEV001/${kind}-SESSION-002/${req.fileName}`;
    rows.push(
      response(
        'expired-new',
        201,
        {
          ...view,
          sessionId: `${kind}-SESSION-002`,
          objectPath: newKey,
          uploadUrl: url(newKey, at(960), 900),
          createdAt: at(960),
          uploadUrlExpiresAt: at(1860),
        },
        960,
      ),
    );
    rows.push({
      id: `${slug}-registered`,
      operationId: 'createMediaUploadSession',
      status: 409,
      body: {
        error: {
          code: 'MEDIA_ALREADY_REGISTERED',
          message: 'The trigger image is already registered',
          requestId: 'sample-registered',
          details: { mediaId: `${kind}-MEDIA-001` },
        },
      },
    });
    const trigger = {
      meta: { id: req.triggerRef.messageId, ts: clock, seq: kind === 'ALARM' ? 184 : 185 },
      data:
        kind === 'ALARM'
          ? { code: 'TEMP_HIGH', status: 'ACTIVE', severity: 'HIGH', category: 'TEMPERATURE', detectedTime: clock }
          : { eventType: 'MACHINE_STARTED', source: 'LOCAL' },
    };
    const message = (suffix, key, seconds, seq) => ({
      meta: { id: `MED-DEV001-${suffix}`, ts: at(seconds), seq },
      data: {
        mediaType: 'IMAGE',
        captureTime: clock,
        fileName: req.fileName,
        objectPath: key,
        sizeKb: req.sizeKb,
        durationSec: 0,
      },
    });
    files[`${slug}-mqtt.json`] = json({
      deviceId: 'DEV001',
      ...(kind === 'ALARM'
        ? {
            cleared: {
              topic: 'bnx/device/DEV001/alarm',
              qos: 1,
              payload: {
                meta: { id: 'ALM-DEV001-186', ts: at(60), seq: 186 },
                data: { code: 'TEMP_HIGH', status: 'CLEARED', detectedTime: at(60) },
              },
            },
          }
        : {}),
      trigger: { topic: `bnx/device/DEV001/${slug}`, qos: 1, payload: trigger },
      media: {
        topic: 'bnx/device/DEV001/media',
        qos: 1,
        payload: message(kind === 'ALARM' ? '907' : '908', key, 2, kind === 'ALARM' ? 907 : 908),
      },
      replacementMedia: {
        topic: 'bnx/device/DEV001/media',
        qos: 1,
        payload: message(kind === 'ALARM' ? '909' : '910', newKey, 962, kind === 'ALARM' ? 909 : 910),
      },
    });
  }
  for (const [status, code] of [
    [400, 'VALIDATION_FAILED'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [409, 'CONFLICT'],
    [409, 'MEDIA_TRIGGER_CONFLICT'],
    [500, 'INTERNAL_ERROR'],
  ])
    rows.push({
      id: code.toLowerCase(),
      operationId: 'createMediaUploadSession',
      status,
      body: { error: { code, message: 'The request failed', requestId: `sample-${code.toLowerCase()}` } },
    });
  const legacy = read('contracts/rest/fixtures/device-images/legacy-upload-request.json');
  files['legacy-upload-request.json'] = json(legacy);
  const legacyKey = 'media/CUS001/DEV001/LEGACY-SESSION-001/capture.jpg';
  rows.push({
    id: 'legacy-created',
    operationId: 'createMediaUploadSession',
    status: 201,
    body: {
      data: {
        sessionId: 'LEGACY-SESSION-001',
        mediaType: legacy.mediaType,
        fileName: legacy.fileName,
        sizeKb: legacy.sizeKb,
        sizeBytes: legacy.sizeBytes,
        objectPath: legacyKey,
        uploadUrl: url(legacyKey, clock, 900),
        uploadUrlExpiresAt: at(900),
        createdAt: clock,
      },
      meta: meta(),
    },
  });
  files['responses.json'] = json(rows);
  const first = rows.find((entry) => entry.id === 'alarm-created').body.data;
  files['s3-put-examples.json'] = json({
    illustrativeOnly: true,
    signatureUsable: false,
    note: 'Header/checksum illustrations, not cryptographic signatures or credentials. Use the untouched cloud response URL in actual calls.',
    queryChecksum: {
      method: 'PUT',
      url: first.uploadUrl,
      headers: { 'Content-Length': String(first.sizeBytes), 'Content-Type': 'image/jpeg' },
      bodyFile: 'capture.jpg',
    },
    headerChecksum: {
      method: 'PUT',
      url: url(first.objectPath, clock, 900, true),
      headers: {
        'Content-Length': String(first.sizeBytes),
        'Content-Type': 'image/jpeg',
        'x-amz-checksum-sha256': checksum,
      },
      bodyFile: 'capture.jpg',
    },
  });
  files['manifest.json'] = json({
    contractVersion: media.info.version,
    scope: 'cloud-interface-package-only',
    fixtureClock: clock,
    signatureUsable: false,
    jpeg: {
      sizeBytes: files['capture.jpg'].length,
      sizeKb: Math.ceil(files['capture.jpg'].length / 1024),
      sha256: sha(files['capture.jpg']),
      checksumSha256Base64: checksum,
    },
    policy: policy.limits,
    sourceFiles: sources.map((path) => ({ path, sha256: sha(bytes(path)) })),
    files: Object.entries(files).map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) })),
  });
  return files;
}
export function writeOrCheckArchive(check = false) {
  const directory = new URL('docs/api/fixtures/device-archive/', root);
  if (!check) mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(buildArchiveHandoff())) {
    const target = new URL(name, directory);
    if (check) {
      if (!readFileSync(target).equals(value)) throw new Error(`STALE_ARCHIVE_HANDOFF: ${name}`);
    } else writeFileSync(target, value);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeOrCheckArchive(process.argv.includes('--check'));
  process.stdout.write('Device archive cloud handoff: PASS (offline)\n');
}
