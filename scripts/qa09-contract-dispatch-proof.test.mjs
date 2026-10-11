import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMarks, partitionDispatch, validateDispatchReceipt } from './qa09-contract-dispatch-proof.mjs';

const sample = () => ({
  dispatch: {
    enabled: true,
    requestId: 'owned',
    marks: dispatchMarks.map((name, i) => ({
      name,
      requestId: 'owned',
      lower: 100 + i * 100,
      upper: 102 + i * 100,
      cpuUserUs: i * 10,
      cpuSystemUs: i * 2,
    })),
  },
  entryOutput: {
    status: 'COMPLETE',
    requestId: 'owned',
    publicCalls: 1,
    overflow: 0,
    nestedOutputs: 0,
    foreignOutputs: 0,
    probeFailures: 0,
    intervals: [
      {
        ordinal: 0,
        kind: 'OUTPUT',
        phase: 'contract-load-await-queue',
        start: 220,
        end: 240,
        processCpuUs: 30,
        threw: false,
      },
      {
        ordinal: 1,
        kind: 'OUTPUT',
        phase: 'contract-load-await-after-queue',
        start: 420,
        end: 440,
        processCpuUs: 40,
        threw: false,
      },
      { ordinal: 2, kind: 'PUBLIC_CALL', start: 720, end: 750, processCpuUs: 10, threw: false },
    ],
  },
});
test('disjoint bounds conserve both parent brackets, outputs and main-isolate sample counts', () => {
  const s = sample(),
    proof = partitionDispatch(s, [{ at: 350, bucket: 'PRISMA_RUNTIME_LOCATION' }]);
  assert.deepEqual(proof.afterQueue, { wallLowerUs: 294, boundaryUncertaintyUs: 8, enclosingWallUs: 302 });
  assert.deepEqual(proof.driverPrefix, proof.afterQueue);
  assert.deepEqual(
    proof.outputOwnership.map((r) => r.owner),
    ['checkpoint-output-return', 'repository-driver-setup'],
  );
  assert.equal(proof.segments[0].processCpuUs, 12);
  assert.equal(proof.cpuSamples[0].inside + proof.cpuSamples[0].ambiguous + proof.cpuSamples[0].outside, 1);
  assert.equal(proof.cpuSubtractionAllowed, false);
  assert.equal(proof.compilerOnlyAttribution, false);
});
test('output crossing a boundary stays ambiguous; no residual is manufactured', () => {
  const s = sample();
  s.entryOutput.intervals[0].end = 310;
  const p = partitionDispatch(s);
  assert.equal(p.outputOwnership[0].owner, 'AMBIGUOUS');
  assert.ok(p.segments.every((s) => !Object.hasOwn(s, 'unattributedWallUs')));
});
for (const [name, mutate, code] of [
  ['missing point', (s) => s.dispatch.marks.pop(), 'DISPATCH_MARKS'],
  ['duplicate point', (s) => (s.dispatch.marks[2].name = s.dispatch.marks[1].name), 'DISPATCH_MARKS'],
  ['wrong owner', (s) => (s.dispatch.marks[3].requestId = 'foreign'), 'DISPATCH_MARK_ORDER_OWNER'],
  ['backwards clock', (s) => (s.dispatch.marks[3].lower = 0), 'DISPATCH_MARK_ORDER_OWNER'],
  ['negative CPU', (s) => (s.dispatch.marks[3].cpuUserUs = -1), 'DISPATCH_MARK_ORDER_OWNER'],
  ['decreasing CPU', (s) => (s.dispatch.marks[3].cpuUserUs = 0), 'DISPATCH_MARK_ORDER_OWNER'],
  ['missing output owner', (s) => (s.entryOutput.requestId = 'foreign'), 'DISPATCH_OUTPUT_OWNER'],
  ['overflow', (s) => (s.entryOutput.overflow = 1), 'DISPATCH_OUTPUT_OWNER'],
  ['foreign output', (s) => (s.entryOutput.foreignOutputs = 1), 'DISPATCH_OUTPUT_OWNER'],
  ['probe failure', (s) => (s.entryOutput.probeFailures = 1), 'DISPATCH_OUTPUT_OWNER'],
  ['output throw', (s) => (s.entryOutput.intervals[0].threw = true), 'DISPATCH_INTERVAL'],
  ['unknown phase', (s) => (s.entryOutput.intervals[0].phase = 'PRIVATE_SQL'), 'DISPATCH_OUTPUT_ORDER'],
  ['duplicate ordinal', (s) => (s.entryOutput.intervals[1].ordinal = 0), 'DISPATCH_INTERVAL'],
  ['unknown interval', (s) => (s.entryOutput.intervals[2].kind = 'PRIVATE_COMPILER'), 'DISPATCH_INTERVAL'],
  [
    'duplicate public call',
    (s) => s.entryOutput.intervals.push({ ...s.entryOutput.intervals[2], ordinal: 3 }),
    'DISPATCH_PUBLIC_ONCE',
  ],
  ['overlap', (s) => (s.entryOutput.intervals[1].start = 230), 'DISPATCH_OUTPUT_ORDER'],
])
  test(`rejects ${name}`, () => {
    const s = sample();
    mutate(s);
    assert.throws(() => partitionDispatch(s), new RegExp(code));
  });
test('receipt loaders reject target receipts and unknown cases', () => {
  assert.throws(() => validateDispatchReceipt({ kind: 'AWS', gate: 'PASS' }), /DISPATCH_SOURCE/);
});
