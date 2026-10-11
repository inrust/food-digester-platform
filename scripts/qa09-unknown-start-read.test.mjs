import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFixture } from './qa09-ten-device-bridge.mjs';
import { inspectUnknownStart, readUnknownStart } from './qa09-unknown-start-read.mjs';
import { collectUnknownStart } from './read-qa09-unknown-start.mjs';
import { readStartedFixtureBuild } from './qa09-started-build-read.mjs';
const prefix = 'qa09-1234567890abcdef';
const prep = prepareFixture({
  prefix,
  action: 'capacity-readonly',
  devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
  customers: ['a', 'b'].map((suffix, i) => ({
    id: `${i + 1}`.repeat(8) + '-1111-1111-1111-111111111111',
    name: prefix + '-' + suffix,
    suffix,
  })),
});
const id = prep.project.name + ':11111111-1111-1111-1111-111111111111';
const original = () => ({
  gate: 'FAIL',
  sourceHash: prep.sourceHash,
  buildspecHash: prep.buildspecHash,
  failure: { kind: 'START_OUTCOME_UNCONFIRMED' },
  operations: [{ operation: 'start-build', result: 'FAIL', startedAt: '2026-10-11T00:00:00Z' }],
  finishedAt: '2026-10-11T00:00:10Z',
});
const build = (status = 'SUCCEEDED') => ({
  id,
  status,
  startTime: '2026-10-11T00:00:01Z',
  buildspec: prep.project.source.buildspec,
  sourceType: 'NO_SOURCE',
  serviceRole: prep.project.serviceRole,
  vpcConfig: prep.project.vpcConfig,
  environment: structuredClone(prep.project.environment),
});
test('zero exact matches preserves UNKNOWN, never proves nonexecution or permits restart', () => {
  const r = inspectUnknownStart(original(), prep, []);
  assert.equal(r.gate, 'UNKNOWN');
  assert.equal(r.exactMatches, 0);
  assert.equal(r.absenceProvesNonExecution, false);
  assert.equal(r.restartAllowed, false);
});
for (const status of ['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'])
  test(`unique exact ${status} resolves identity only`, async () => {
    const r = inspectUnknownStart(original(), prep, [build(status)]);
    assert.equal(r.gate, 'RESOLVED');
    assert.equal(r.buildId, id);
    assert.equal(r.status, status);
    assert.equal(r.executionGate, 'NOT_ASSESSED');
    assert.equal(r.cleanupGate, 'NOT_ASSESSED');
    assert.equal(r.originalStartGate, 'UNKNOWN');
    assert.equal(r.originalGate, 'FAIL');
    if (!['IN_PROGRESS', 'SUCCEEDED'].includes(status))
      await assert.rejects(
        readStartedFixtureBuild(prep, id, async () => build(status)),
        /NOT_VERIFIED/,
      );
  });
test('two exact builds are ambiguous even if both succeeded', () => {
  const other = { ...build(), id: id.replace('11111111', '22222222') };
  assert.equal(inspectUnknownStart(original(), prep, [build(), other]).gate, 'BLOCKED');
});
for (const field of [
  'serviceRole',
  'sourceType',
  'buildspec',
  'vpcConfig',
  'sourceHash',
  'planBytes',
  'duplicatePlan',
  'planType',
])
  test(`foreign ${field} cannot acquire ownership`, () => {
    const b = build();
    if (field === 'sourceHash')
      b.environment.environmentVariables.find((x) => x.name === 'QA09_FIXTURE_HASH').value = '0'.repeat(64);
    else if (field === 'planBytes')
      b.environment.environmentVariables.find((x) => x.name === 'QA09_FIXTURE_PLAN_B64').value = Buffer.from(
        JSON.stringify({ ...prep.plan, action: 'observe' }),
      ).toString('base64');
    else if (field === 'duplicatePlan')
      b.environment.environmentVariables.push(
        b.environment.environmentVariables.find((x) => x.name === 'QA09_FIXTURE_PLAN_B64'),
      );
    else if (field === 'planType')
      b.environment.environmentVariables.find((x) => x.name === 'QA09_FIXTURE_PLAN_B64').type = 'PARAMETER_STORE';
    else b[field] = field === 'vpcConfig' ? {} : 'foreign';
    assert.equal(inspectUnknownStart(original(), prep, [b]).gate, 'UNKNOWN');
  });
test('truncated recent window cannot resolve; an older boundary is required', () => {
  assert.equal(
    inspectUnknownStart(original(), prep, [build()], { truncated: true }).reason,
    'INVENTORY_WINDOW_INCOMPLETE',
  );
  const older = {
    ...build(),
    id: id.replace('11111111', '33333333'),
    startTime: '2026-10-10T23:57:59Z',
    buildspec: 'foreign',
  };
  assert.equal(inspectUnknownStart(original(), prep, [build(), older], { truncated: true }).gate, 'RESOLVED');
});
for (const startTime of ['2026-10-10T23:57:59Z', '2026-10-11T00:00:41Z'])
  test(`outside start window ${startTime} is blocked`, () => {
    assert.equal(
      inspectUnknownStart(original(), prep, [{ ...build(), startTime }]).reason,
      'EXACT_BUILD_OUTSIDE_START_WINDOW',
    );
  });
test('malformed dates, duplicate IDs, bound drift and known started receipts fail closed', () => {
  assert.throws(() => inspectUnknownStart(original(), prep, [{ ...build(), startTime: 'invalid' }]), /START_TIME/);
  assert.throws(() => inspectUnknownStart(original(), prep, [build(), build()]), /DUPLICATE/);
  for (const patch of [
    { build: { id } },
    { sourceHash: '0'.repeat(64) },
    { gate: 'PASS' },
    { finishedAt: 'invalid' },
    { operations: [] },
  ])
    assert.throws(() => inspectUnknownStart({ ...original(), ...patch }, prep, []), /RECEIPT_REQUIRED/);
  assert.throws(() => inspectUnknownStart(original(), { ...prep, buildspecHash: '0'.repeat(64) }, []), /BINDING/);
  const foreign = structuredClone(prep);
  foreign.project.serviceRole = 'foreign';
  assert.throws(() => inspectUnknownStart(original(), foreign, []), /BINDING/);
});
const reads = (overrides = {}) => ({
  identity: async () => ({ Account: '065986019555' }),
  list: async () => ({ ids: [id] }),
  builds: async () => [build()],
  ...overrides,
});
test('global two transient read recoveries, ledger and original failures are retained', async () => {
  let calls = 0,
    ticks = 0;
  const observations = [];
  const r = await readUnknownStart(
    original(),
    prep,
    reads({
      list: async () => {
        calls++;
        if (calls < 3) throw Object.assign(Error('private'), { code: 'AWS_list-builds-for-project_CLI_READ_TIMEOUT' });
        return { ids: [id] };
      },
    }),
    {
      observations,
      now: () => ticks,
      pause: async (ms) => {
        ticks += ms;
      },
    },
  );
  assert.equal(calls, 3);
  assert.equal(r.readRecoveries, 2);
  assert.equal(r.readGate, 'RECOVERED');
  assert.equal(r.originalReadGate, 'FAIL');
  assert.equal(observations.filter((x) => x.result === 'FAIL').length, 2);
  assert.ok(!JSON.stringify(observations).includes('private'));
});
for (const code of [
  'AWS_list-builds-for-project_AccessDeniedException',
  'AWS_list-builds-for-project_SSO_SESSION_EXPIRED',
  'CLI_INVALID_JSON',
  'CLI_FAILED',
])
  test(`permanent ${code} has no retry`, async () => {
    let calls = 0;
    await assert.rejects(
      readUnknownStart(
        original(),
        prep,
        reads({
          list: async () => {
            calls++;
            throw Object.assign(Error('private'), { code });
          },
        }),
      ),
      /private/,
    );
    assert.equal(calls, 1);
  });
test('repeated transient failure stops at three reads across the fixed inventory operation', async () => {
  let calls = 0;
  await assert.rejects(
    readUnknownStart(
      original(),
      prep,
      reads({
        list: async () => {
          calls++;
          throw Object.assign(Error('redacted'), { code: 'AWS_list-builds-for-project_CLI_READ_TIMEOUT' });
        },
      }),
      { pause: async () => {} },
    ),
    /redacted/,
  );
  assert.equal(calls, 3);
});
test('elapsed read budget, wrong account, incomplete inventory and foreign returned IDs block admission', async () => {
  let ticks = 0,
    calls = 0;
  await assert.rejects(
    readUnknownStart(
      original(),
      prep,
      reads({
        identity: async () => {
          ticks = 10;
          return { Account: '065986019555' };
        },
        list: async () => {
          calls++;
        },
      }),
      { now: () => ticks, timeoutMs: 10 },
    ),
    /TIMEOUT/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    readUnknownStart(original(), prep, reads({ identity: async () => ({ Account: '999999999999' }) })),
    /WRONG_ACCOUNT/,
  );
  for (const builds of [[], [{ ...build(), id: id.replace('11111111', '44444444') }]])
    await assert.rejects(readUnknownStart(original(), prep, reads({ builds: async () => builds })), /INCOMPLETE/);
});
test('real reader wrapper calls only fixed read APIs, does not persist other build payloads, and refuses overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-unknown-'));
  try {
    const input = join(dir, 'original.json'),
      out = join(dir, 'read.json'),
      calls = [];
    const bytes = JSON.stringify(original()),
      prepBytes = JSON.stringify(prep);
    writeFileSync(input, bytes);
    writeFileSync(input + '.preparation.json', prepBytes);
    const r = await collectUnknownStart(input, out, {
      aws: (args, profile, limits) => {
        calls.push(args[1]);
        assert.equal(profile, 'esgiot-readonly');
        assert.ok(limits.timeoutMs <= 30000);
        if (args[1] === 'get-caller-identity') return { Account: '065986019555' };
        if (args[1] === 'list-builds-for-project') return { ids: [id] };
        if (args[1] === 'batch-get-builds') return [{ ...build(), privatePayload: 'private-password-token' }];
        throw Error('MUTATION_DEPENDENCY_FORBIDDEN');
      },
    });
    assert.deepEqual(calls, ['get-caller-identity', 'list-builds-for-project', 'batch-get-builds']);
    assert.equal(r.gate, 'RESOLVED');
    assert.ok(!readFileSync(out, 'utf8').includes('private-password-token'));
    assert.ok(!readFileSync(out, 'utf8').includes('buildspec'));
    assert.equal(readFileSync(input, 'utf8'), bytes);
    assert.equal(readFileSync(input + '.preparation.json', 'utf8'), prepBytes);
    await assert.rejects(collectUnknownStart(input, out), /NEW_UNKNOWN_START_OUTPUT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
