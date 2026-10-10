import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAccountReadTargetConfig } from './qa09-account-read-config.mjs';
const fixture = (candidate, preconnect = true) => [
  {
    gate: 'PASS',
    sourceCommit: 'a'.repeat(40),
    runId: '1',
    engineCpu: true,
    authenticatedPreconnect: preconnect,
    accountReadCandidate: candidate,
  },
  {
    gate: 'PASS',
    sourceCommit: 'a'.repeat(40),
    lambdaArtifacts: Array.from({ length: 19 }, (_, i) => ({
      name: i === 0 ? 'fdp-test-api' : `worker-${i}`,
      matches: true,
      revisionId: 'revision',
      codeSha256: 'code',
    })),
  },
  {
    name: 'fdp-test-api',
    revisionId: 'revision',
    codeSha256: 'code',
    state: 'Active',
    update: 'Successful',
    envName: 'test',
    pool: '1',
    memory: 512,
    runtime: 'nodejs24.x',
    architecture: 'arm64',
    engineCpu: 'true',
    preconnect: String(preconnect),
    accountReadCandidate: String(candidate),
  },
  { ReservedConcurrentExecutions: 12 },
];
test('actual config guard accepts R0/R1 and final false restore without declaring business/P95', () => {
  for (const args of [fixture(false), fixture(true), fixture(false, false)]) {
    const r = validateAccountReadTargetConfig(...args);
    assert.equal(r.gate, 'PASS');
    assert.equal(r.p95Accepted, false);
    assert.equal(r.fullQa09Accepted, false);
  }
});
for (const [key, value] of [
  ['accountReadCandidate', 'false'],
  ['pool', '2'],
  ['memory', 1024],
  ['preconnect', 'false'],
  ['engineCpu', 'false'],
  ['envName', 'prod'],
  ['revisionId', 'changed'],
  ['codeSha256', 'changed'],
  ['state', 'Pending'],
  ['architecture', 'x86_64'],
])
  test(`config rejects ${key} drift`, () => {
    const f = fixture(true);
    f[2][key] = value;
    assert.throws(() => validateAccountReadTargetConfig(...f));
  });
test('config rejects source, inventory and concurrency drift', () => {
  for (const mutate of [
    (f) => (f[1].sourceCommit = 'b'.repeat(40)),
    (f) => f[1].lambdaArtifacts.pop(),
    (f) => (f[1].lambdaArtifacts[0].matches = false),
    (f) => (f[3].ReservedConcurrentExecutions = 13),
  ]) {
    const f = fixture(true);
    mutate(f);
    assert.throws(() => validateAccountReadTargetConfig(...f));
  }
});

test('new detail receipts require explicit matching actual flag, including false restore', () => {
  for (const on of [false, true]) {
    const f = fixture(false, on);
    f[0].contractLoadDetail = on;
    f[2].contractLoadDetail = String(on);
    assert.equal(validateAccountReadTargetConfig(...f).gate, 'PASS');
    for (const actual of [undefined, 'yes', String(!on)]) {
      f[2].contractLoadDetail = actual;
      assert.throws(() => validateAccountReadTargetConfig(...f));
    }
  }
  const f = fixture(false, false);
  f[0].contractLoadDetail = true;
  f[2].contractLoadDetail = 'true';
  assert.throws(() => validateAccountReadTargetConfig(...f));
});

test('public mode is exact and guarded; missing actual field cannot pass true or false restore', () => {
  for (const on of [false, true]) {
    const f = fixture(false, on);
    Object.assign(f[0], { contractLoadDetail: on, contractPublicBoundaries: on });
    Object.assign(f[2], { contractLoadDetail: String(on), contractPublicBoundaries: String(on) });
    assert.equal(validateAccountReadTargetConfig(...f).gate, 'PASS');
    for (const actual of [undefined, 'yes', String(!on)]) {
      f[2].contractPublicBoundaries = actual;
      assert.throws(() => validateAccountReadTargetConfig(...f));
    }
  }
  const f = fixture(false, true);
  f[0].contractPublicBoundaries = true;
  f[2].contractPublicBoundaries = 'true';
  assert.throws(() => validateAccountReadTargetConfig(...f), /ACTUAL_GUARD/);
});
