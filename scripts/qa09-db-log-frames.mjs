const marker = '{"kind":"fdp-qa09-ten-device-db/v1"';
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
    if (!pending && !message.startsWith(marker)) continue;
    if (pending && message.startsWith(marker)) throw Error('FIXTURE_FRAME_INTERRUPTED');
    pending += message;
    let value;
    try {
      value = JSON.parse(pending);
    } catch {
      continue;
    }
    if (value.kind !== 'fdp-qa09-ten-device-db/v1') throw Error('FIXTURE_FRAME_INVALID');
    frames.push(value);
    pending = '';
  }
  if (pending) throw Error('FIXTURE_FRAME_TRUNCATED');
  return frames;
}
