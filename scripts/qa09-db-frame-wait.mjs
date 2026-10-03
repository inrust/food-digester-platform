import { decodeFixtureFrames } from './qa09-db-log-frames.mjs';
export async function readVerifiedFixtureFrame(
  read,
  expected,
  {
    maxAttempts = 15,
    timeoutMs = 45000,
    now = () => Date.now(),
    pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const started = now(),
    observations = [];
  for (let attempt = 1; attempt <= maxAttempts && now() - started <= timeoutMs; attempt++) {
    try {
      const log = await read();
      const frames = decodeFixtureFrames(log.events);
      observations.push({ attempt, eventCount: log.events.length, frameCount: frames.length });
      if (frames.length) {
        if (
          frames.length !== 1 ||
          frames[0].buildId !== expected.buildId ||
          frames[0].sourceHash !== expected.sourceHash ||
          frames[0].prefix !== expected.prefix ||
          frames[0].action !== expected.action ||
          frames[0].gate !== 'PASS'
        )
          throw Error('FIXTURE_RESULT_NOT_VERIFIED');
        return { frame: frames[0], observations };
      }
    } catch (e) {
      const code = e.code ?? e.message;
      if (
        e.message !== 'FIXTURE_FRAME_TRUNCATED' &&
        !/(CLI_FAILED|Throttl|RequestTimeout|ServiceUnavailable|NetworkingError)/.test(code)
      )
        throw e;
      observations.push({ attempt, errorCode: code });
    }
    if (attempt < maxAttempts && now() - started < timeoutMs) await pause(2000);
  }
  throw Object.assign(Error('FIXTURE_RESULT_READ_TIMEOUT'), { observations });
}
