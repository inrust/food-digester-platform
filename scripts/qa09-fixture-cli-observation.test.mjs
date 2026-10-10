import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareFixture } from './qa09-ten-device-bridge.mjs';
const prefix = 'qa09-1234567890abcdef';
const plan = {
  prefix,
  action: 'observe',
  devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
  customers: [
    { id: '11111111-1111-1111-1111-111111111111', name: prefix + '-a', suffix: 'a' },
    { id: '22222222-2222-2222-2222-222222222222', name: prefix + '-b', suffix: 'b' },
  ],
};
const id = 'fdp-test-qa09-ten-device-fixtures:11111111-1111-1111-1111-111111111111';
const bridge = new URL('./qa09-ten-device-bridge.mjs', import.meta.url).href;
// A local AWS executable shim: no SDK, network or target credentials are invoked.
const shim = `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const c=JSON.parse(readFileSync(process.env.QA09_FAKE_CONFIG));
const op=process.argv[3];appendFileSync(c.calls,op+'\\n');
const emit=(x)=>process.stdout.write(JSON.stringify(x));
const fail=(code)=>{process.stderr.write('An error occurred ('+code+') sensitive-password-token');process.exit(1)};
if(op===c.failOperation && c.failures?.length){
 const code=c.failures.shift();writeFileSync(process.env.QA09_FAKE_CONFIG,JSON.stringify(c));
 if(code==='network'){process.stderr.write('Could not connect to the endpoint URL sensitive-password-token');process.exit(1)};
 if(code==='expired'){process.stderr.write('Token has expired and refresh failed sensitive-password-token');process.exit(1)};
 if(code==='unknown'){process.stderr.write('unknown sensitive-password-token');process.exit(1)};
 if(code==='invalid-json'){process.stdout.write('sensitive-password-token');process.exit(0)};
 fail(code);
}
if(op==='get-caller-identity')emit({Account:c.wrongAccount?'999999999999':'065986019555'});
else if(op==='batch-get-projects')emit({projects:c.missingProject?[]:[{...c.prep.project,
 ...(c.wrongRole?{serviceRole:'foreign'}:{}),
 ...(c.changedProject?{source:{...c.prep.project.source,buildspec:'changed'}}:{})}]});
else if(op==='create-project'||op==='update-project')emit({});
else if(op==='start-build'){
 if(c.mode==='start-fail')fail('AccessDeniedException');
 if(c.mode==='start-uncertain'){process.stderr.write('Read timeout on endpoint URL');process.exit(1)};
 const at=process.argv.indexOf('--environment-variables-override');
 if(at<0)fail('InvalidParameterException');
 emit({id:c.id,status:'IN_PROGRESS'});
}
else if(op==='batch-get-builds'){
 if(c.mode==='read-fail')fail('AccessDeniedException');
 if(c.mode==='transient'&&!c.retried){c.retried=true;writeFileSync(process.env.QA09_FAKE_CONFIG,JSON.stringify(c));process.stderr.write('Read timeout on endpoint URL sensitive-password-token');process.exit(1)};
 emit({id:c.id,status:c.mode==='terminal-fail'?'FAILED':'SUCCEEDED',phase:'COMPLETED',buildspec:c.prep.project.source.buildspec,
 sourceType:'NO_SOURCE',serviceRole:c.prep.project.serviceRole,vpcConfig:c.prep.project.vpcConfig,environment:c.prep.project.environment,
 logs:{groupName:'own',streamName:'own'}});
}
else if(op==='get-log-events')emit({events:[{message:JSON.stringify({kind:'fdp-qa09-ten-device-db/v1',buildId:c.id,sourceHash:c.prep.sourceHash,prefix:c.prep.plan.prefix,action:c.prep.plan.action,gate:'PASS'})}]});
else fail('InvalidParameterException');`;
function execute(mode, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-cli-observation-'));
  try {
    const output = join(dir, 'result.json'),
      config = join(dir, 'config.json'),
      calls = join(dir, 'calls.log');
    writeFileSync(config, JSON.stringify({ mode, prep: prepareFixture(plan), calls, id, ...extra }));
    writeFileSync(join(dir, 'aws'), `#!${process.execPath}\n${shim}`, { mode: 0o755 });
    const runner = join(dir, 'runner.mjs');
    writeFileSync(
      runner,
      `import {runFixture} from ${JSON.stringify(bridge)};try {await runFixture(${JSON.stringify(plan)},${JSON.stringify(output)});} catch {process.exitCode=1;}`,
    );
    const run = spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, QA09_FAKE_CONFIG: config },
    });
    const result = JSON.parse(readFileSync(output)),
      called = readFileSync(calls, 'utf8').trim().split('\n');
    return {
      result,
      called,
      status: run.status,
      started: existsSync(output + '.started.json') ? JSON.parse(readFileSync(output + '.started.json')) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('pre-start rejection is persisted and never retried; no started receipt or SQL is invented', () => {
  const r = execute('start-fail');
  assert.equal(r.status, 1);
  assert.equal(r.started, null);
  assert.equal(r.called.filter((x) => x === 'start-build').length, 1);
  assert.ok(!r.called.includes('batch-get-builds'));
  assert.equal(r.result.gate, 'FAIL');
  assert.equal(r.result.failure.kind, 'PRE_START_OR_MUTATION_FAILURE');
  assert.equal(r.result.operations.at(-1).failure.code, 'AWS_start-build_AccessDeniedException');
  assert.ok(!JSON.stringify(r.result).includes('sensitive-password-token'));
});
test('post-start authorization rejection retains exact Build receipt and failed read with no restart', () => {
  const r = execute('read-fail');
  assert.equal(r.status, 1);
  assert.equal(r.started.build.id, id);
  assert.equal(r.result.build.id, id);
  assert.equal(r.result.gate, 'FAIL');
  assert.equal(r.called.filter((x) => x === 'start-build').length, 1);
  assert.equal(r.called.filter((x) => x === 'batch-get-builds').length, 1);
  assert.equal(r.result.failure.startedBuildMayStillRun, true);
  assert.ok(!r.called.includes('get-log-events'));
  assert.equal(r.result.buildReads[0].failure.code, 'AWS_batch-get-builds_AccessDeniedException');
});
test('terminal failed Build remains FAIL, is known terminal and never reads successful frame', () => {
  const r = execute('terminal-fail');
  assert.equal(r.status, 1);
  assert.equal(r.result.gate, 'FAIL');
  assert.equal(r.result.failure.startedBuildMayStillRun, false);
  assert.ok(!r.called.includes('get-log-events'));
});
test('in-budget transient read recovers the same Build, retains original FAIL and runs mutation once', () => {
  const r = execute('transient');
  assert.equal(r.status, 0);
  assert.equal(r.result.gate, 'PASS');
  assert.equal(r.result.readGate, 'RECOVERED');
  assert.equal(r.result.originalReadGate, 'FAIL');
  assert.equal(r.result.buildReads[0].result, 'FAIL');
  assert.equal(r.result.readRecoveries, 1);
  assert.equal(r.called.filter((x) => x === 'start-build').length, 1);
  assert.equal(r.called.filter((x) => x === 'batch-get-builds').length, 2);
  assert.equal(r.result.result.buildId, id);
  assert.ok(!JSON.stringify(r.result).includes('sensitive-password-token'));
});

test('lost start response is UNKNOWN, never assumed unstarted, restarted or attributed to an invented Build', () => {
  const r = execute('start-uncertain');
  assert.equal(r.status, 1);
  assert.equal(r.started, null);
  assert.equal(r.result.gate, 'FAIL');
  assert.equal(r.result.failure.kind, 'START_OUTCOME_UNCONFIRMED');
  assert.equal(r.result.failure.startedBuildMayStillRun, true);
  assert.equal(r.result.failure.recoveryAction, 'READ_ONLY_DIAGNOSTIC_REQUIRED_NO_RESTART');
  assert.equal(r.called.filter((x) => x === 'start-build').length, 1);
  assert.ok(!r.called.includes('batch-get-builds'));
});

for (const operation of ['get-caller-identity', 'batch-get-projects'])
  test(`pre-start ${operation} recovers twice with immutable failures and exactly one StartBuild`, () => {
    const r = execute('pass', { failOperation: operation, failures: ['network', 'ThrottlingException'] });
    assert.equal(r.status, 0);
    assert.equal(r.result.gate, 'PASS');
    assert.equal(r.result.readGate, 'RECOVERED');
    assert.equal(r.result.originalReadGate, 'FAIL');
    assert.equal(r.result.preStartReadFailures, 2);
    assert.equal(r.called.filter((x) => x === operation).length, 3);
    assert.equal(r.called.filter((x) => x === 'start-build').length, 1);
    assert.ok(!r.called.includes('update-project') && !r.called.includes('create-project'));
    assert.deepEqual(
      r.result.preStartReads.filter((x) => x.operation.endsWith(operation)).map((x) => x.result),
      ['FAIL', 'FAIL', 'PASS'],
    );
    assert.ok(!JSON.stringify(r.result).includes('sensitive-password-token'));
  });

for (const failure of ['network', 'AccessDeniedException', 'expired', 'unknown', 'invalid-json'])
  test(`pre-start project ${failure} fails closed before mutation or StartBuild`, () => {
    const r = execute('pass', { failOperation: 'batch-get-projects', failures: Array(4).fill(failure) });
    assert.equal(r.status, 1);
    assert.equal(r.started, null);
    assert.equal(r.result.gate, 'FAIL');
    assert.equal(r.result.failure.kind, 'PRE_START_OR_MUTATION_FAILURE');
    assert.equal(r.result.failure.startedBuildMayStillRun, false);
    assert.equal(r.called.filter((x) => x === 'batch-get-projects').length, failure === 'network' ? 3 : 1);
    assert.ok(
      !r.called.some((x) => ['start-build', 'update-project', 'create-project', 'batch-get-builds'].includes(x)),
    );
    assert.ok(!JSON.stringify(r.result).includes('sensitive-password-token'));
  });

for (const [operation, extra] of [
  ['update-project', { changedProject: true }],
  ['create-project', { missingProject: true }],
])
  test(`${operation} network failure is never retried or followed by StartBuild`, () => {
    const r = execute('pass', { ...extra, failOperation: operation, failures: ['network', 'network'] });
    assert.equal(r.status, 1);
    assert.equal(r.started, null);
    assert.equal(r.called.filter((x) => x === operation).length, 1);
    assert.ok(!r.called.includes('start-build'));
  });

for (const extra of [{ wrongAccount: true }, { wrongRole: true }])
  test(`successful read with ${Object.keys(extra)[0]} never retries semantic verification`, () => {
    const r = execute('pass', extra);
    assert.equal(r.status, 1);
    assert.equal(r.started, null);
    assert.equal(r.called.filter((x) => x === 'get-caller-identity').length, 1);
    assert.ok(r.called.filter((x) => x === 'batch-get-projects').length <= 1);
    assert.ok(!r.called.some((x) => ['start-build', 'update-project', 'create-project'].includes(x)));
  });

for (const [operation, extra] of [
  ['update-project', { changedProject: true }],
  ['create-project', { missingProject: true }],
])
  test(`project read recovery permits one reviewed ${operation} and one StartBuild`, () => {
    const r = execute('pass', { ...extra, failOperation: 'batch-get-projects', failures: ['network'] });
    assert.equal(r.status, 0);
    assert.equal(r.result.gate, 'PASS');
    assert.equal(r.result.originalReadGate, 'FAIL');
    assert.equal(r.called.filter((x) => x === 'batch-get-projects').length, 2);
    assert.equal(r.called.filter((x) => x === operation).length, 1);
    assert.equal(r.called.filter((x) => x === 'start-build').length, 1);
  });

test('recovered project read never converts a later lost StartBuild response into a safe retry', () => {
  const r = execute('start-uncertain', { failOperation: 'batch-get-projects', failures: ['network'] });
  assert.equal(r.status, 1);
  assert.equal(r.started, null);
  assert.equal(r.result.failure.kind, 'START_OUTCOME_UNCONFIRMED');
  assert.equal(r.result.failure.startedBuildMayStillRun, true);
  assert.equal(r.called.filter((x) => x === 'batch-get-projects').length, 2);
  assert.equal(r.called.filter((x) => x === 'start-build').length, 1);
  assert.ok(!r.called.includes('batch-get-builds'));
});
