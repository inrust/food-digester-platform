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
if(op==='get-caller-identity')emit({Account:'065986019555'});
else if(op==='batch-get-projects')emit({projects:[c.prep.project]});
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
function execute(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-cli-observation-'));
  try {
    const output = join(dir, 'result.json'),
      config = join(dir, 'config.json'),
      calls = join(dir, 'calls.log');
    writeFileSync(config, JSON.stringify({ mode, prep: prepareFixture(plan), calls, id }));
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
