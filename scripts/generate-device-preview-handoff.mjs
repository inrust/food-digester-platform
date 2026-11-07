#!/usr/bin/env node
/** Offline third-party handoff. No credentials, network, device activation or deployment. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { subsetOpenApi } from './cloud-handoff-openapi.mjs';

const root = new URL('../', import.meta.url);
const sourceFiles = [
  'contracts/rest/live-image-api.json',
  'contracts/rest/openapi-base.json',
  'contracts/domain/camera-interaction-policy.json',
  'contracts/rest/fixtures/device-images/frame-request.json',
  'contracts/rest/fixtures/device-images/capture.jpg',
];
const bytes = (path) => readFileSync(new URL(path, root));
const read = (path) => JSON.parse(bytes(path));
const live = read(sourceFiles[0]),
  base = read(sourceFiles[1]);
export const DEVICE_PREVIEW_PATHS = ['/api/v1/device/live-image/state', '/api/v1/device/live-image/frames'];
export function buildHandoff() {
  const { paths, components } = subsetOpenApi({
    document: live,
    documents: { 'openapi-base.json': base, 'live-image-api.json': live },
    paths: DEVICE_PREVIEW_PATHS,
    securitySchemes: ['DeviceMtls'],
  });
  const openapi = {
    openapi: live.openapi,
    info: {
      ...live.info,
      title: 'Device Live Image API - Third-party Handoff',
      description:
        'Generated subset of the frozen cloud contract. Two device mTLS endpoints only. Local source verification does not establish target deployment.',
      'x-delivery-scope': 'cloud-interface-package',
    },
    servers: [
      {
        url: 'https://device-api.example.invalid',
        description:
          'Replace with the cloud environment URL confirmed for integration. This example host is not reachable.',
      },
    ],
    tags: live.tags.filter((tag) => tag.name === 'device'),
    paths,
    components,
  };
  const frame = read(sourceFiles[3]);
  const timestamp = frame.capturedAt;
  const later = (ms) => new Date(Date.parse(timestamp) + ms).toISOString();
  const meta = { requestId: 'sample-device-preview', timestamp };
  const examples = [
    {
      id: 'state-idle',
      operationId: 'getDeviceLiveImageState',
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: { data: { state: 'IDLE', pollIntervalMs: 5000 }, meta },
    },
    {
      id: 'state-active',
      operationId: 'getDeviceLiveImageState',
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: {
        data: {
          state: 'ACTIVE',
          pollIntervalMs: 5000,
          streamId: frame.streamId,
          activeUntil: later(30000),
          uploadIntervalMs: 2000,
          maxImageBytes: 131072,
        },
        meta,
      },
    },
    ...[false, true].map((replayed) => ({
      id: replayed ? 'frame-replayed' : 'frame-accepted',
      operationId: 'uploadDeviceLiveImageFrame',
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: {
        data: { frameId: frame.frameId, receivedAt: later(400), expiresAt: later(10000), replayed },
        meta: { ...meta, timestamp: later(400) },
      },
    })),
  ];
  const errors = [
    [400, 'VALIDATION_FAILED'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'LIVE_STREAM_INACTIVE'],
    [409, 'STALE_FRAME'],
    [409, 'FRAME_CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [429, 'RATE_LIMITED'],
    [503, 'TEMPORARILY_UNAVAILABLE'],
  ];
  for (const [status, code] of errors) {
    examples.push({
      id: `frame-${code.toLowerCase()}`,
      operationId: 'uploadDeviceLiveImageFrame',
      status,
      headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '1' } : {}) },
      body: { error: { code, message: 'The request failed', requestId: `sample-${code.toLowerCase()}` } },
    });
    if ([400, 401, 403, 404, 429, 503].includes(status))
      examples.push({
        id: `state-${code.toLowerCase()}`,
        operationId: 'getDeviceLiveImageState',
        status,
        headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '1' } : {}) },
        body: { error: { code, message: 'The request failed', requestId: `sample-${code.toLowerCase()}` } },
      });
  }
  const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const files = {
    'openapi.json': json(openapi),
    'frame-request.json': json(frame),
    'capture.jpg': bytes(sourceFiles[4]),
    'responses.json': json(examples),
  };
  const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
  files['manifest.json'] = json({
    contractVersion: live.info.version,
    decision: 'DEC-009@2.0.0',
    scope: 'cloud-interface-package-only',
    fixtureClock: timestamp,
    sourceFiles: sourceFiles.map((path) => ({ path, sha256: sha256(bytes(path)) })),
    files: Object.entries(files).map(([path, value]) => ({ path, bytes: value.length, sha256: sha256(value) })),
  });
  return files;
}
export function writeOrCheckHandoff(check = false) {
  const directory = new URL('docs/api/fixtures/device-preview/', root);
  if (!check) mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(buildHandoff())) {
    const path = new URL(name, directory);
    if (check) {
      if (!readFileSync(path).equals(value)) throw new Error(`STALE_HANDOFF_FILE: ${name}`);
    } else writeFileSync(path, value);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeOrCheckHandoff(process.argv.includes('--check'));
  process.stdout.write('Device preview cloud handoff: PASS (offline)\n');
}
