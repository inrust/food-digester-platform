import { createHash } from 'node:crypto';
import { decode } from 'jpeg-js';
import { CAMERA_INTERACTION_POLICY } from '@fdp/contracts/domain/camera-interaction-policy.js';
import type { LiveFrameCreate } from '@fdp/contracts/rest/image-types.js';
import { parseStrictObject } from '../admin/shared/strict-object.js';
import { LiveImageLeaseError } from './service.js';

const policy = CAMERA_INTERACTION_POLICY.liveImage;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;
const invalid = () => new LiveImageLeaseError('VALIDATION_FAILED');

export interface ValidatedLiveImageFrame {
  readonly payload: LiveFrameCreate;
  readonly jpeg: Buffer;
  readonly capturedAtMs: number;
  readonly requestHash: string;
}

/** Production HTTP adapters must pass the raw JSON body so escape/whitespace bytes count. */
export function parseLiveImageFrame(body: unknown): ValidatedLiveImageFrame {
  let serialized: string;
  try {
    serialized = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    throw invalid();
  }
  if (typeof serialized !== 'string') throw invalid();
  if (Buffer.byteLength(serialized, 'utf8') > policy.maxRequestBytes)
    throw new LiveImageLeaseError('PAYLOAD_TOO_LARGE');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalid();
  }
  const input = parseStrictObject(value, ['streamId', 'frameId', 'capturedAt', 'mimeType', 'imageBase64'], invalid);
  for (const key of ['streamId', 'frameId', 'capturedAt', 'mimeType', 'imageBase64']) {
    if (typeof input[key] !== 'string') throw invalid();
  }
  const payload: LiveFrameCreate = {
    streamId: input.streamId as string,
    frameId: input.frameId as string,
    capturedAt: input.capturedAt as string,
    mimeType: 'image/jpeg',
    imageBase64: input.imageBase64 as string,
  };
  if (!UUID.test(payload.streamId) || !UUID.test(payload.frameId) || input.mimeType !== 'image/jpeg') throw invalid();
  const capturedAtMs = Date.parse(payload.capturedAt);
  if (
    !UTC.test(payload.capturedAt) ||
    !Number.isFinite(capturedAtMs) ||
    new Date(capturedAtMs).toISOString().slice(0, 19) !== payload.capturedAt.slice(0, 19)
  )
    throw invalid();
  const encoded = payload.imageBase64;
  if (encoded.length > 4 * Math.ceil(policy.maxImageBytes / 3)) throw new LiveImageLeaseError('PAYLOAD_TOO_LARGE');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid();
  const jpeg = Buffer.from(encoded, 'base64');
  if (jpeg.length > policy.maxImageBytes) throw new LiveImageLeaseError('PAYLOAD_TOO_LARGE');
  if (jpeg.toString('base64') !== encoded) throw invalid();
  // Fixed field ordering gives the same request hash regardless of JSON property order.
  const requestHash = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  return { payload, jpeg, capturedAtMs, requestHash };
}

/** Some decoders accept a frame header with no scan and synthesize blank pixels. */
function assertJpegScan(jpeg: Buffer): void {
  let offset = 2;
  while (offset < jpeg.length - 2) {
    if (jpeg[offset] !== 0xff) throw invalid();
    while (jpeg[offset] === 0xff) offset++;
    const marker = jpeg[offset++]!;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) throw invalid();
    const length = jpeg.readUInt16BE(offset);
    if (length < 2 || offset + length > jpeg.length - 2) throw invalid();
    if (marker === 0xda) {
      const components = jpeg[offset + 2]!;
      if (components < 1 || components > 4 || length !== 6 + 2 * components || offset + length >= jpeg.length - 2)
        throw invalid();
      return;
    }
    offset += length;
  }
  throw invalid();
}

/** A successful header check alone is insufficient: perform a bounded full decode. */
export function validateLiveImageJpeg(jpeg: Buffer): void {
  try {
    if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9)
      throw invalid();
    assertJpegScan(jpeg);
    const image = decode(jpeg, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: policy.maxPixels / 1_000_000,
      maxMemoryUsageInMB: 64,
    });
    if (
      image.width < 1 ||
      image.height < 1 ||
      image.width > policy.maxDimensionPx ||
      image.height > policy.maxDimensionPx ||
      image.width * image.height > policy.maxPixels ||
      image.data.length !== image.width * image.height * 3
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}
