import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const markers = ['{"kind":"fdp-qa09-ten-device-db/v1"', '{"kind":"fdp-qa09-ten-device-db/gzip-v1"'];
const startsFrame = (message) => markers.some((marker) => message.startsWith(marker));
export function decodeFixtureFrames(events) {
  if (!Array.isArray(events) || events.length > 10000) throw Error('FIXTURE_LOG_LIMIT');
  const frames = [];
  let pending = '',
    bytes = 0;
  for (const e of events) {
    if (typeof e.message !== 'string') throw Error('FIXTURE_LOG_INVALID');
    bytes += Buffer.byteLength(e.message);
    if (bytes > 8 * 1024 * 1024) throw Error('FIXTURE_LOG_LIMIT');
    const message = e.message;
    if (!pending && !startsFrame(message)) continue;
    if (pending && startsFrame(message)) throw Error('FIXTURE_FRAME_INTERRUPTED');
    pending += message;
    let value;
    try {
      value = JSON.parse(pending);
    } catch {
      continue;
    }
    if (value.kind === 'fdp-qa09-ten-device-db/gzip-v1') {
      if (
        !Number.isSafeInteger(value.rawBytes) ||
        value.rawBytes < 1 ||
        value.rawBytes > 8 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(value.sha256 ?? '') ||
        typeof value.payloadBase64 !== 'string'
      )
        throw Error('FIXTURE_FRAME_ENCODING');
      let raw;
      try {
        const compressed = Buffer.from(value.payloadBase64, 'base64');
        if (compressed.toString('base64') !== value.payloadBase64) throw Error('NONCANONICAL_BASE64');
        raw = gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 });
      } catch {
        throw Error('FIXTURE_FRAME_ENCODING');
      }
      if (raw.length !== value.rawBytes || createHash('sha256').update(raw).digest('hex') !== value.sha256)
        throw Error('FIXTURE_FRAME_DIGEST_MISMATCH');
      try {
        value = JSON.parse(raw.toString('utf8'));
      } catch {
        throw Error('FIXTURE_FRAME_ENCODING');
      }
    }
    if (!value || typeof value !== 'object' || value.kind !== 'fdp-qa09-ten-device-db/v1')
      throw Error('FIXTURE_FRAME_INVALID');
    frames.push(value);
    pending = '';
  }
  if (pending) throw Error('FIXTURE_FRAME_TRUNCATED');
  return frames;
}
