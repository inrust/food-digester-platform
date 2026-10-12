import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFixture } from './qa09-ten-device-bridge.mjs';
import { inspectUnknownStart, readUnknownStart, UNKNOWN_START_READ_BUDGET } from './qa09-unknown-start-read.mjs';
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
        assert.ok(limits.timeoutMs <= 15000);
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

const inventory = (count) =>
  Array.from({ length: count }, (_, i) => ({
    ...build(),
    id: prep.project.name + ':' + i.toString(16).padStart(8, '0') + '-1111-1111-1111-111111111111',
    buildspec: i === 0 ? prep.project.source.buildspec : 'foreign',
    startTime: i === count - 1 && count > 1 ? '2026-10-10T23:58:00Z' : '2026-10-11T00:00:01Z',
  }));
for (const count of [0, 1, 5, 6, 12, 50])
  test(`serial inventory ${count}: exact batches, no early unique acceptance, no payload persistence`, async () => {
    const all = inventory(count),
      requested = [],
      observations = [];
    let active = 0;
    const r = await readUnknownStart(
      original(),
      prep,
      reads({
        list: async () => ({ ids: all.map((b) => b.id) }),
        builds: async (ids, limits) => {
          assert.equal(active++, 0);
          assert.ok(ids.length <= 5);
          assert.equal(limits.timeoutMs, 15000);
          requested.push([...ids]);
          await Promise.resolve();
          active--;
          return all.filter((b) => ids.includes(b.id)).reverse();
        },
      }),
      { observations, now: () => 0 },
    );
    assert.deepEqual(
      requested.flat(),
      all.map((b) => b.id),
    );
    assert.deepEqual(
      requested.map((b) => b.length),
      Array.from({ length: Math.ceil(count / 5) }, (_, i) => Math.min(5, count - i * 5)),
    );
    assert.equal(r.readBatchCount, Math.ceil(count / 5));
    assert.equal(r.gate, count ? 'RESOLVED' : 'UNKNOWN');
    assert.deepEqual(r.readBudget, UNKNOWN_START_READ_BUDGET);
    assert.equal(r.originalGate, 'FAIL');
    assert.equal(r.restartAllowed, false);
    assert.equal(r.executionGate, 'NOT_ASSESSED');
    const batches = observations.filter((row) => row.operation === 'codebuild:batch-get-builds');
    assert.deepEqual(
      batches.map((row) => [row.batch, row.batchSize]),
      requested.map((ids, i) => [i + 1, ids.length]),
    );
    assert.ok(!JSON.stringify(observations).includes('buildspec'));
  });

test('later batch ambiguity blocks the early exact match; later old boundary closes window coverage', async () => {
  const all = inventory(12);
  const run = () =>
    readUnknownStart(
      original(),
      prep,
      reads({
        list: async () => ({ ids: all.map((b) => b.id), NextToken: 'remaining' }),
        builds: async (ids) => all.filter((b) => ids.includes(b.id)),
      }),
    );
  assert.equal((await run()).gate, 'RESOLVED');
  all[11].startTime = '2026-10-10T23:58:00.001Z';
  assert.equal((await run()).reason, 'INVENTORY_WINDOW_INCOMPLETE');
  all[11].startTime = '2026-10-10T23:58:00Z';
  all[6].buildspec = prep.project.source.buildspec;
  assert.equal((await run()).reason, 'AMBIGUOUS_EXACT_BUILDS');
});

for (const variant of ['duplicate', 'missing', 'foreign', 'cross-batch', 'non-array', 'invalid-time'])
  test(`batch response ${variant} fails closed without proceeding to the next batch`, async () => {
    const all = inventory(12);
    let calls = 0;
    await assert.rejects(
      readUnknownStart(
        original(),
        prep,
        reads({
          list: async () => ({ ids: all.map((b) => b.id) }),
          builds: async (ids) => {
            calls++;
            const details = all.filter((b) => ids.includes(b.id));
            if (variant === 'duplicate') details[1] = details[0];
            if (variant === 'missing') details.pop();
            if (variant === 'foreign') details[1] = { ...details[1], id };
            if (variant === 'cross-batch') details[1] = all[6];
            if (variant === 'non-array') return { builds: details };
            if (variant === 'invalid-time') details[1].startTime = 'invalid';
            return details;
          },
        }),
      ),
      variant === 'invalid-time' ? /START_TIME/ : /INCOMPLETE/,
    );
    // Timestamp validation belongs to the complete ownership inspection, not partial unique acceptance.
    assert.equal(calls, variant === 'invalid-time' ? 3 : 1);
  });

for (const ids of [null, inventory(51).map((b) => b.id), [id, id], ['foreign-project:' + id.split(':')[1]]])
  test(`invalid list ${JSON.stringify(ids).slice(0, 70)} cannot trigger any detail read`, async () => {
    let calls = 0;
    await assert.rejects(
      readUnknownStart(
        original(),
        prep,
        reads({
          list: async () => ({ ids }),
          builds: async () => {
            calls++;
            return [];
          },
        }),
      ),
      /INVALID_UNKNOWN_START_INVENTORY/,
    );
    assert.equal(calls, 0);
  });

for (const timeoutMs of [0, -1, 90001, 1.5, NaN])
  test(`invalid total budget ${timeoutMs} makes no AWS call`, async () => {
    let calls = 0;
    await assert.rejects(
      readUnknownStart(
        original(),
        prep,
        reads({
          identity: async () => {
            calls++;
          },
        }),
        { timeoutMs },
      ),
      /INVALID_UNKNOWN_START_READ_BUDGET/,
    );
    assert.equal(calls, 0);
  });

test('single total deadline shrinks the final CLI allowance and prevents all later batches', async () => {
  const all = inventory(12),
    limits = [],
    observations = [];
  let ticks = 0;
  await assert.rejects(
    readUnknownStart(
      original(),
      prep,
      reads({
        list: async () => ({ ids: all.map((b) => b.id) }),
        builds: async (ids, limit) => {
          limits.push(limit.timeoutMs);
          ticks += limits.length === 1 ? 80000 : 10000;
          return all.filter((b) => ids.includes(b.id));
        },
      }),
      { now: () => ticks, observations },
    ),
    /UNKNOWN_START_READ_TIMEOUT/,
  );
  assert.deepEqual(limits, [15000, 10000]);
  assert.equal(observations.at(-1).result, 'FAIL');
  assert.equal(observations.at(-1).elapsedMs, 90000);
});

test('observation persistence time counts against the total deadline before the next read', async () => {
  let ticks = 0,
    calls = 0;
  await assert.rejects(
    readUnknownStart(
      original(),
      prep,
      reads({
        list: async () => {
          calls++;
        },
      }),
      {
        now: () => ticks,
        timeoutMs: 10,
        onObservation: (row) => {
          if (row.result === 'PASS') ticks = 10;
        },
      },
    ),
    /UNKNOWN_START_READ_TIMEOUT/,
  );
  assert.equal(calls, 0);
});

test('two global recoveries in different batches use at most fourteen CLI invocations for fifty IDs', async () => {
  const all = inventory(50),
    observations = [],
    seen = new Map();
  let ticks = 0;
  const r = await readUnknownStart(
    original(),
    prep,
    reads({
      list: async () => ({ ids: all.map((b) => b.id) }),
      builds: async (ids) => {
        const count = (seen.get(ids[0]) ?? 0) + 1;
        seen.set(ids[0], count);
        if ([all[0].id, all[45].id].includes(ids[0]) && count === 1)
          throw Object.assign(Error('private-secret'), { code: 'AWS_batch-get-builds_CLI_READ_TIMEOUT' });
        return all.filter((b) => ids.includes(b.id));
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
  assert.equal(r.gate, 'RESOLVED');
  assert.equal(observations.length, 14);
  assert.equal(r.readRecoveries, 2);
  assert.equal(r.originalReadGate, 'FAIL');
  assert.deepEqual(
    observations.filter((r) => r.result === 'FAIL').map((r) => r.batch),
    [1, 10],
  );
  assert.ok(!JSON.stringify(observations).includes('private-secret'));
});

test('third transient across distinct batches cannot reset the recovery allowance', async () => {
  const all = inventory(20),
    seen = new Map(),
    observations = [];
  await assert.rejects(
    readUnknownStart(
      original(),
      prep,
      reads({
        list: async () => ({ ids: all.map((b) => b.id) }),
        builds: async (ids) => {
          const count = (seen.get(ids[0]) ?? 0) + 1;
          seen.set(ids[0], count);
          if (count === 1) throw Object.assign(Error('transient'), { code: 'AWS_batch-get-builds_CLI_NETWORK_ERROR' });
          return all.filter((b) => ids.includes(b.id));
        },
      }),
      { observations, pause: async () => {} },
    ),
    /transient/,
  );
  assert.equal(seen.get(all[10].id), 1);
  assert.equal(seen.has(all[15].id), false);
  assert.equal(observations.filter((r) => r.result === 'FAIL').length, 3);
});

test('actual CLI entry uses read-only small batches, immutable original bytes and identity-only receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-unknown-cli-'));
  try {
    const input = join(dir, 'original.json'),
      out = join(dir, 'read.json'),
      log = join(dir, 'calls.jsonl');
    const all = inventory(12),
      bytes = JSON.stringify(original()),
      prepBytes = JSON.stringify(prep);
    writeFileSync(input, bytes);
    writeFileSync(input + '.preparation.json', prepBytes);
    writeFileSync(join(dir, 'builds.json'), JSON.stringify(all));
    const executable = join(dir, 'aws');
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const all = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'builds.json'))}));
const op = args[1];
if (op === 'get-caller-identity') console.log(JSON.stringify({Account:'065986019555'}));
else if (op === 'list-builds-for-project') console.log(JSON.stringify({ids:all.map(b=>b.id)}));
else if (op === 'batch-get-builds') {
  const ids = args.slice(args.indexOf('--ids')+1, args.indexOf('--query'));
  if (ids.length > 5) process.exit(91);
  console.log(JSON.stringify(all.filter(b=>ids.includes(b.id)).map(b=>({...b,privatePayload:'unpersisted-secret'}))));
} else process.exit(92);
`,
    );
    chmodSync(executable, 0o700);
    const run = spawnSync(process.execPath, ['scripts/read-qa09-unknown-start.mjs', input, out], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, PATH: dir + ':' + process.env.PATH },
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(readFileSync(out)),
      calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      calls.map((args) => args[1]),
      ['get-caller-identity', 'list-builds-for-project', ...Array(3).fill('batch-get-builds')],
    );
    assert.ok(calls.every((args) => args[args.indexOf('--profile') + 1] === 'esgiot-readonly'));
    assert.equal(receipt.readBatchCount, 3);
    assert.equal(receipt.gate, 'RESOLVED');
    assert.equal(receipt.originalGate, 'FAIL');
    assert.equal(receipt.executionGate, 'NOT_ASSESSED');
    assert.equal(receipt.restartAllowed, false);
    assert.equal(receipt.writes, 0);
    assert.equal(receipt.readBudget.cliTimeoutMs, 15000);
    assert.ok(!readFileSync(out, 'utf8').includes('unpersisted-secret'));
    assert.equal(readFileSync(input, 'utf8'), bytes);
    assert.equal(readFileSync(input + '.preparation.json', 'utf8'), prepBytes);
    const overwrite = spawnSync(process.execPath, ['scripts/read-qa09-unknown-start.mjs', input, out], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(overwrite.status, 0);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RUNNING observation cost cannot start a read after the deadline', async () => {
  let ticks = 0,
    calls = 0;
  const observations = [];
  await assert.rejects(
    readUnknownStart(
      original(),
      prep,
      reads({
        identity: async () => {
          calls++;
        },
      }),
      {
        observations,
        now: () => ticks,
        timeoutMs: 10,
        onObservation: (row) => {
          if (row.result === 'RUNNING') ticks = 10;
        },
      },
    ),
    /UNKNOWN_START_READ_TIMEOUT/,
  );
  assert.equal(calls, 0);
  assert.equal(observations[0].result, 'FAIL');
});

for (const scenario of ['no-match', 'ambiguous', 'partial', 'denied'])
  test(`wrapper ${scenario} retains original failure, safe partial observations and no restart authority`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa09-unknown-failure-'));
    try {
      const input = join(dir, 'original.json'),
        out = join(dir, 'read.json'),
        all = inventory(12);
      if (scenario === 'no-match') all[0].buildspec = 'foreign';
      if (scenario === 'ambiguous') all[6].buildspec = prep.project.source.buildspec;
      const bytes = JSON.stringify(original()),
        prepBytes = JSON.stringify(prep);
      writeFileSync(input, bytes);
      writeFileSync(input + '.preparation.json', prepBytes);
      let batches = 0;
      const receipt = await collectUnknownStart(input, out, {
        aws: (args) => {
          if (args[1] === 'get-caller-identity') return { Account: '065986019555' };
          if (args[1] === 'list-builds-for-project') return { ids: all.map((b) => b.id) };
          assert.equal(args[1], 'batch-get-builds');
          batches++;
          const ids = args.slice(args.indexOf('--ids') + 1, args.indexOf('--query'));
          if (batches === 2 && scenario === 'denied')
            throw Object.assign(Error('private-password-token'), {
              code: 'AWS_batch-get-builds_AccessDeniedException',
            });
          if (batches === 2 && scenario === 'partial') return [];
          return all.filter((b) => ids.includes(b.id));
        },
      });
      assert.equal(
        receipt.gate,
        scenario === 'no-match' ? 'UNKNOWN' : scenario === 'ambiguous' ? 'BLOCKED' : 'UNAVAILABLE',
      );
      assert.equal(batches, ['partial', 'denied'].includes(scenario) ? 2 : 3);
      assert.equal(receipt.originalGate, 'FAIL');
      assert.equal(receipt.originalStartGate, 'UNKNOWN');
      assert.equal(receipt.restartAllowed, false);
      assert.equal(receipt.absenceProvesNonExecution, false);
      assert.equal(receipt.executionGate, 'NOT_ASSESSED');
      assert.equal(receipt.cleanupGate, 'NOT_ASSESSED');
      assert.equal(receipt.writes, 0);
      assert.equal(readFileSync(input, 'utf8'), bytes);
      assert.equal(readFileSync(input + '.preparation.json', 'utf8'), prepBytes);
      assert.ok(!readFileSync(out, 'utf8').includes('private-password-token'));
      if (scenario === 'denied') assert.equal(receipt.observations.at(-1).result, 'FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
