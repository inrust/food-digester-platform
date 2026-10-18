import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignCpuClock,
  validateCpuProfile,
  attributeCpuSamples,
  summarizeCpuCase,
  cpuCases,
} from './qa09-contract-cpu-proof.mjs';
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

function mappedProfile(offsetUs) {
  const p = profile();
  const origin = 10_000_000_000;
  p.startBracket = { lower: origin + 1000, upper: origin + 1100 };
  p.stopBracket = { lower: origin + 5900, upper: origin + 6100 };
  return {
    ...p,
    ...alignCpuClock({
      startTime: origin + 1000 - offsetUs,
      endTime: origin + 6000 - offsetUs,
      startBracket: p.startBracket,
      stopBracket: p.stopBracket,
    }),
  };
}
for (const offsetUs of [0, 5_117_315_336, -5_117_315_336])
  test(`map independently bracketed V8/hrtime clocks with offset ${offsetUs}`, () => {
    const p = mappedProfile(offsetUs);
    assert.equal(p.rawClock.startTime, 10_000_001_000 - offsetUs);
    assert.deepEqual(p.timeDeltas, [1000, 1000, 1000]);
    assert.equal(p.clockToleranceUs, 100);
    const points = validateCpuProfile(p);
    assert.equal(points.length, 3);
    assert.equal(points[0].at, 10_000_002_050);
    assert.equal(points[0].uncertaintyUs, 150);
  });

for (const [name, mutate] of [
  ['raw start', (p) => (p.rawClock.startTime -= 1000)],
  ['raw end', (p) => (p.rawClock.endTime += 1000)],
  ['normalized start', (p) => (p.startTime -= 101)],
  ['offset bounds', (p) => (p.clockMapping.lowerOffsetUs -= 1)],
  ['uncertainty', (p) => (p.clockMapping.uncertaintyUs = 100)],
  ['mapping scope', (p) => (p.clockMapping.scope = 'EXACT_SAMPLE_TIME')],
])
  test(`reject inconsistent clock mapping: ${name}`, () => {
    const p = mappedProfile(5_117_315_336);
    mutate(p);
    assert.throws(() => validateCpuProfile(p), /CPU_CLOCK_ALIGNMENT/);
  });

test('mapping uncertainty makes boundary samples ambiguous instead of asserting false ownership', () => {
  const points = validateCpuProfile(mappedProfile(5_117_315_336));
  const at = points[0].at;
  const spans = [
    { phase: 'one', start: { lower: at - 120, upper: at - 120 }, end: { lower: at + 120, upper: at + 120 } },
  ];
  const [mapped] = attributeCpuSamples(points, spans);
  assert.deepEqual([mapped.inside, mapped.ambiguous, mapped.outside], [0, 1, 2]);
  const [withoutUncertainty] = attributeCpuSamples(
    points.map(({ at, bucket }) => ({ at, bucket })),
    spans,
  );
  assert.equal(withoutUncertainty.inside, 1);
  assert.throws(
    () => attributeCpuSamples([{ at, bucket: 'NODE_INTERNAL', uncertaintyUs: 99 }], spans),
    /CPU_SAMPLE_UNCERTAINTY/,
  );
});
