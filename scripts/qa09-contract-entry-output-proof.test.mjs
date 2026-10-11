import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionEntryOutput,
  entryOutputCases,
  proposedEntryOutputSummary,
} from './qa09-contract-entry-output-proof.mjs';
const sample = () => ({
  entryOutput: {
    requestId: 'gateway',
    lambdaRequestId: 'lambda',
    enabled: true,
    publicCalls: 1,
    overflow: 0,
    nestedOutputs: 0,
    foreignOutputs: 0,
    probeFailures: 0,
    diagnosticEmissions: 0,
    status: 'COMPLETE',
    intervals: [
      {
        ordinal: 0,
        kind: 'OUTPUT',
        phase: 'contract-load-await-after-queue',
        start: 100,
        end: 200,
        processCpuUs: 50,
        threw: false,
      },
      { ordinal: 1, kind: 'PUBLIC_CALL', start: 250, end: 500, processCpuUs: 100, threw: false },
      {
        ordinal: 2,
        kind: 'OUTPUT',
        phase: 'contract-load-result-to-model',
        start: 650,
        end: 700,
        processCpuUs: 20,
        threw: false,
      },
      {
        ordinal: 3,
        kind: 'OUTPUT',
        phase: 'contract-load-result-after-model',
        start: 810,
        end: 850,
        processCpuUs: 20,
        threw: false,
      },
    ],
  },
  spans: [
    { phase: 'contract-load-driver-submit', start: { upper: 90 }, end: { lower: 550 }, sharedEnd: true },
    { phase: 'contract-load-result-after-model', start: { upper: 600 }, end: { lower: 800 }, sharedEnd: true },
  ],
});
test('partition conserves driver prefix/call/tail; terminal output is outside after-model, CPU is never subtracted', () => {
  const p = partitionEntryOutput(sample());
  assert.equal(p.gate, 'PASS');
  assert.equal(
    p.segments.slice(0, 3).reduce((s, r) => s + r.wallUs, 0),
    460,
  );
  assert.deepEqual(
    p.outputRows.map((r) => r.owner),
    ['driver-prefix', 'after-model', 'OUTSIDE'],
  );
  assert.equal(p.segments[3].outputWallUs, 50);
  assert.equal(p.segments[3].unattributedWallUs, 150);
  assert.equal(p.cpuSubtractionAllowed, false);
  assert.equal(p.compilerOnlyAttribution, false);
});
for (const [name, mutate, code] of [
  [
    'overlapping output',
    (s) => {
      s.entryOutput.intervals[2].start = 150;
    },
    'ENTRY_OUTPUT_DOUBLE_COUNT',
  ],
  [
    'duplicate ordinal',
    (s) => {
      s.entryOutput.intervals[2].ordinal = 0;
    },
    'ENTRY_OUTPUT_INTERVAL',
  ],
  [
    'negative CPU',
    (s) => {
      s.entryOutput.intervals[0].processCpuUs = -1;
    },
    'ENTRY_OUTPUT_INTERVAL',
  ],
  [
    'public port before driver',
    (s) => {
      s.entryOutput.intervals[1].start = 0;
    },
    'ENTRY_SEGMENT_ORDER',
  ],
  [
    'two public owners',
    (s) => {
      s.entryOutput.publicCalls = 2;
    },
    'ENTRY_PUBLIC_OWNER',
  ],
  [
    'unknown phase',
    (s) => {
      s.entryOutput.intervals[0].phase = 'PRIVATE_SQL';
    },
    'ENTRY_OUTPUT_INTERVAL',
  ],
  [
    'non-shared span',
    (s) => {
      s.spans[0].sharedEnd = false;
    },
    'ENTRY_SHARED_SPAN',
  ],
  [
    'recursive diagnostic emission',
    (s) => {
      s.entryOutput.diagnosticEmissions = 1;
    },
    'ENTRY_OUTPUT_BUDGET',
  ],
  [
    'missing degraded status',
    (s) => {
      s.entryOutput.overflow = 1;
    },
    'ENTRY_OUTPUT_STATUS',
  ],
])
  test(`reject ${name}`, () => {
    const s = sample();
    mutate(s);
    assert.throws(() => partitionEntryOutput(s), new RegExp(code));
  });
test('straddling output remains ambiguous and is not subtracted from either segment', () => {
  const s = sample();
  s.entryOutput.intervals[0].start = 230;
  s.entryOutput.intervals[0].end = 270;
  const p = partitionEntryOutput(s);
  assert.equal(p.outputRows[0].owner, 'AMBIGUOUS');
  assert.equal(p.segments[0].outputWallUs, 0);
  assert.equal(p.segments[1].outputWallUs, 0);
});
test('degraded receipts preserve measurements but disable residual subtraction', () => {
  const s = sample();
  s.entryOutput.status = 'OUTPUT_FAILED';
  s.entryOutput.intervals[0].threw = true;
  const p = partitionEntryOutput(s);
  assert.equal(p.gate, 'EXPECTED_DEGRADED');
  assert.ok(p.segments.every((r) => r.unattributedWallUs === null));
  assert.equal(entryOutputCases.length, 14);
});

test('full proposed summary has distinct owner IDs, bounded bytes and no detailed output/payload fields', () => {
  const s = sample(),
    p = partitionEntryOutput(s);
  assert.ok(p.proposedSummaryBytes <= 4096);
  assert.equal(p.proposedSummary.gatewayRequestId, 'gateway');
  assert.equal(p.proposedSummary.lambdaRequestId, 'lambda');
  assert.equal(p.proposedSummary.proposedOnly, true);
  assert.equal(p.proposedSummary.outputRows, undefined);
  assert.equal(proposedEntryOutputSummary({ enabled: false }, p), null);
  assert.throws(
    () => proposedEntryOutputSummary({ ...s.entryOutput, requestId: 'x'.repeat(129) }, p),
    /ENTRY_SUMMARY_IDS/,
  );
});
