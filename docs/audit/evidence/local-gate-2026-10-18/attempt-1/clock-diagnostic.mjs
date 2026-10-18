import { Session } from 'node:inspector/promises';
const mono = () => Number(process.hrtime.bigint() / 1000n);
const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 1000 });
const lower = mono();
await session.post('Profiler.start');
const upper = mono();
const workStart = mono();
while (mono() - workStart < 20000) {}
const stopLower = mono();
const { profile } = await session.post('Profiler.stop');
const stopUpper = mono();
console.log(JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  startBracket: { lower, upper }, rawStartTime: profile.startTime,
  stopBracket: { lower: stopLower, upper: stopUpper }, rawEndTime: profile.endTime,
  startClockDifferenceUs: lower - profile.startTime,
  endClockDifferenceUs: stopLower - profile.endTime,
  sampleCount: profile.samples.length,
  scope: 'CLOCK_DIAGNOSTIC_ONLY_NOT_CPU_TIME_OR_TARGET_ACCEPTANCE',
}, null, 2));
session.disconnect();
