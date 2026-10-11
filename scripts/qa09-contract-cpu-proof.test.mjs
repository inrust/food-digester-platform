import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCpuProfile, attributeCpuSamples, summarizeCpuCase, cpuCases } from './qa09-contract-cpu-proof.mjs';
const profile = () => ({
  scope: 'V8_MAIN_ISOLATE_LOCATION_SAMPLES_NOT_CPU_TIME',
  intervalUs: 1000,
  clockToleranceUs: 100,
  originalSha256: 'a'.repeat(64),
  startTime: 1000,
  endTime: 6000,
  startBracket: { lower: 1000, upper: 1100 },
  stopBracket: { lower: 5900, upper: 6100 },
  nodes: [{ id: 1, callFrame: { url: 'node:timers', functionName: 'timer' } }],
  samples: [1, 1, 1],
  timeDeltas: [1000, 1000, 1000],
});
test('public samples conserve per-window counts; boundary uncertainty is not CPU time', () => {
  const points = validateCpuProfile(profile());
  const [row] = attributeCpuSamples(points, [
    { phase: 'one', start: { lower: 1950, upper: 2050 }, end: { lower: 4050, upper: 4150 }, sharedEnd: true },
  ]);
  assert.equal(row.inside, 1);
  assert.equal(row.ambiguous, 2);
  assert.equal(row.outside, 0);
  assert.equal(row.buckets.NODE_INTERNAL, 1);
});
for (const [name, mutate, code] of [
  [
    'clock offset',
    (p) => {
      p.startTime -= 101;
    },
    'CPU_CLOCK_ALIGNMENT',
  ],
  [
    'clock end',
    (p) => {
      p.endTime = 7000;
    },
    'CPU_CLOCK_ALIGNMENT',
  ],
  [
    'bad sample id',
    (p) => {
      p.samples[0] = 99;
    },
    'CPU_PROFILE_SAMPLE',
  ],
  [
    'negative interval',
    (p) => {
      p.timeDeltas[0] = -1;
    },
    'CPU_PROFILE_SAMPLE',
  ],
  [
    'clock overrun',
    (p) => {
      p.timeDeltas[0] = 6000;
    },
    'CPU_PROFILE_SAMPLE_CLOCK',
  ],
  [
    'duplicate node',
    (p) => {
      p.nodes.push(p.nodes[0]);
    },
    'CPU_PROFILE_NODE',
  ],
  [
    'private path',
    (p) => {
      p.nodes[0].callFrame.url = '/private/account/path';
    },
    'CPU_PROFILE_NODE',
  ],
  [
    'missing delta',
    (p) => {
      p.timeDeltas.pop();
    },
    'CPU_PROFILE_BUDGET',
  ],
  [
    'unbounded samples',
    (p) => {
      p.samples = Array(45001).fill(1);
      p.timeDeltas = Array(45001).fill(1);
    },
    'CPU_PROFILE_BUDGET',
  ],
  [
    'CPU-time claim',
    (p) => {
      p.scope = 'COMPILER_CPU_TIME';
    },
    'CPU_PROFILE_SCOPE',
  ],
])
  test(`reject ${name}`, () => {
    const p = profile();
    mutate(p);
    assert.throws(() => validateCpuProfile(p), new RegExp(code));
  });
test('duplicate or inverted spans cannot double count', () => {
  const span = { phase: 'one', start: { lower: 1, upper: 2 }, end: { lower: 3, upper: 4 } };
  assert.throws(() => attributeCpuSamples([], [span, span]), /CPU_SPAN_BOUNDARY/);
  assert.throws(() => attributeCpuSamples([], [{ ...span, end: { lower: 0, upper: 1 } }]), /CPU_SPAN_BOUNDARY/);
});
test('fixed matrix includes off, measurement overhead, account, five location controls and four failures', () => {
  assert.equal(Object.keys(cpuCases).length, 14);
  assert.equal(cpuCases['default-off'].profile, false);
  assert.equal(cpuCases['public-on'].profile, false);
  assert.equal(Object.keys(cpuCases).filter((k) => k.endsWith('reject')).length, 4);
  assert.throws(() => summarizeCpuCase({ kind: 'qa09-runtime-public-seams/v1', case: 'profile-on' }), /CPU_SOURCE/);
});
