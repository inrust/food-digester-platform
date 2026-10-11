import test from 'node:test';
import { createHash } from 'node:crypto';
import { checkLogReadBudget } from './check-qa09-log-read-budget.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function evidence(name, receipt) {
  const root = process.env.QA09_LOG_READ_EVIDENCE_DIR;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  const path = join(root, name + '.json');
  assert.equal(existsSync(path), false, 'FRESH_MATRIX_EVIDENCE_REQUIRED');
  writeFileSync(
    path,
    JSON.stringify({ scope: 'LOCAL_CONTROLLED_NO_AWS', fullQa09Accepted: false, ...receipt }, null, 2) + '\n',
  );
}

const readerWrapper = String.raw`
import sys,json,subprocess
sys.dont_write_bytecode=True
sys.path.insert(0,'scripts')
import qa09_log_read as m
fault=sys.argv[1];clock=[0];calls=[]
m.time.monotonic=lambda:clock[0]
def run(args,**kw):
    calls.append({'timeout':kw['timeout'],'singleAttempt':kw['env']['AWS_MAX_ATTEMPTS']=='1','args':args})
    n=len(calls);body={'events':[]}
    if fault=='timeout': raise subprocess.TimeoutExpired(args,kw['timeout'],stderr='PRIVATE_SENTINEL')
    if fault=='unavailable': raise OSError('PRIVATE_SENTINEL')
    if fault in ['denied','sso','throttled','unknown']:
        errors={'denied':'AccessDeniedException','sso':'Token has expired and refresh failed','throttled':'ThrottlingException','unknown':'unexpected'}
        return subprocess.CompletedProcess(args,1,'PRIVATE_SENTINEL',errors[fault]+' PRIVATE_SENTINEL')
    if fault=='late': clock[0]+=120
    if fault=='deadline':
        clock[0]+=14 if n<9 else 8
        body['nextToken']='PRIVATE_SENTINEL-'+str(n)
    if fault in ['repeat','page-limit','call-limit']:
        body['nextToken']='PRIVATE_SENTINEL-'+('same' if fault=='repeat' else str(n))
        if fault=='call-limit' and n%19==0: del body['nextToken']
    if fault=='invalid-json': return subprocess.CompletedProcess(args,0,'PRIVATE_SENTINEL','')
    if fault=='invalid-events': body={'events':[{'message':True}]}
    if fault=='missing-events': body={}
    if fault=='many-events': body={'events':[{'message':'x'}]*1001}
    if fault=='invalid-token': body['nextToken']=False
    if fault=='empty-token': body['nextToken']=''
    if fault=='long-token': body['nextToken']='x'*8193
    if fault=='oversize': return subprocess.CompletedProcess(args,0,'x'*(4*1024*1024+1),'')
    return subprocess.CompletedProcess(args,0,json.dumps(body),'')
m.subprocess.run=run
r=m.LogReader();pages=[]
if fault=='before-start': clock[0]=120
if fault=='fractional': clock[0]=119.9999
for i in range(4 if fault=='call-limit' else 2):
    pages+=list(r.pages('gateway' if i==0 else 'lambda','fixed-group',100,200,query=i))
if fault=='finish-deadline': clock[0]=120
budget=r.finish()
# Never persist filter arguments or pagination tokens as part of receipts.
print(json.dumps({'budget':budget,'groupErrors':r.group_errors,'pages':len(pages),'calls':[{'timeout':c['timeout'],'singleAttempt':c['singleAttempt'],'noPaginate':'--no-paginate' in c['args'],'readTimeout':c['args'][c['args'].index('--cli-read-timeout')+1]} for c in calls]}))
`;
function python(wrapper, args) {
  const result = spawnSync('python3', ['-c', wrapper, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('PRIVATE_SENTINEL'));
  return JSON.parse(result.stdout);
}
for (const [fault, error, calls] of [
  ['before-start', 'LOG_TOTAL_DEADLINE_EXCEEDED', 0],
  ['timeout', 'LOG_READ_TIMEOUT', 1],
  ['unavailable', 'LOG_CLI_UNAVAILABLE', 1],
  ['denied', 'LOG_ACCESS_DENIED', 1],
  ['sso', 'LOG_SSO_EXPIRED', 1],
  ['throttled', 'LOG_THROTTLED', 1],
  ['unknown', 'LOG_READ_FAILED', 1],
  ['late', 'LOG_TOTAL_DEADLINE_EXCEEDED', 1],
  ['deadline', 'LOG_TOTAL_DEADLINE_EXCEEDED', 9],
  ['repeat', 'LOG_PAGINATION_INCOMPLETE', 2],
  ['page-limit', 'LOG_PAGINATION_INCOMPLETE', 20],
  ['call-limit', 'LOG_CALL_LIMIT', 40],
  ['invalid-json', 'LOG_INVALID_RESPONSE', 1],
  ['invalid-events', 'LOG_INVALID_RESPONSE', 1],
  ['missing-events', 'LOG_INVALID_RESPONSE', 1],
  ['many-events', 'LOG_INVALID_RESPONSE', 1],
  ['invalid-token', 'LOG_INVALID_RESPONSE', 1],
  ['empty-token', 'LOG_INVALID_RESPONSE', 1],
  ['long-token', 'LOG_INVALID_RESPONSE', 1],
  ['oversize', 'LOG_RESPONSE_LIMIT', 1],
  ['finish-deadline', 'LOG_TOTAL_DEADLINE_EXCEEDED', 2],
]) {
  test('bounded log reader stops safely: ' + fault, () => {
    const r = python(readerWrapper, [fault]);
    assert.equal(r.budget.error, error);
    assert.equal(r.calls.length, calls);
    assert.equal(r.budget.attempts.length, calls);
    assert.equal(r.budget.totalDeadlineMs, 120000);
    assert.equal(r.budget.automaticRetries, 0);
    assert.equal(r.budget.readConcurrency, 1);
    assert.ok(
      r.calls.every(
        (c) => c.timeout <= 15 && c.timeout > 0 && c.singleAttempt && c.noPaginate && c.readTimeout === '10',
      ),
    );
    if (fault === 'deadline') assert.equal(r.calls.at(-1).timeout, 8);
    if (fault === 'late') assert.equal(r.pages, 0);
    if (fault === 'call-limit') assert.equal(r.budget.attempts.at(-1).query, 2);
    evidence('reader-' + fault, r);
  });
}

test('submillisecond remaining budget is positive and cannot round into an expired receipt', () => {
  const r = python(readerWrapper, ['fractional']);
  assert.equal(r.budget.error, null);
  assert.equal(r.budget.elapsedMs, 119999);
  assert.ok(r.calls.every((c) => c.timeout > 0 && c.timeout < 0.001));
  assert.ok(r.budget.attempts.every((a) => a.timeoutMs === 1));
  evidence('reader-fractional-budget', r);
});

const collectorWrapper = String.raw`
import sys,json,subprocess,hashlib,runpy,contextlib,io
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,'scripts')
import qa09_log_read as m
source,prior,target,fault=sys.argv[1:];receipt=json.load(open(source));attempts=receipt['cold409Sampling']['attempts']
clock=[0];calls=[];active=[0];peak=[0];records=[]
m.time.monotonic=lambda:clock[0]
for i,a in enumerate(attempts):
    o=a['observation'];rid=o['gatewayRequestId'];inv='10000000-0000-4000-8000-'+str(i).zfill(12)
    g={'requestId':rid,'extendedRequestId':'extended-'+rid,'integrationRequestId':inv,'requestTimeEpoch':1791264000000,'httpMethod':'PATCH','status':str(o['status']),'integrationStatus':'200','functionStatus':str(o['status'])}
    records.append({'requestId':rid,'gateway':[g]})
p={'sourceReceiptSha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'sourceCommit':receipt['sourceCommit'],'prefix':receipt['prefix'],'records':records}
Path(prior).write_text(json.dumps(p));before=Path(prior).read_bytes();expected=hashlib.sha256(before).hexdigest()
if fault=='prior-drift': Path(prior).write_bytes(before+b'\n')
if fault=='source-drift': Path(source).write_bytes(Path(source).read_bytes()+b'\n')
if fault=='overwrite': Path(target).write_text('keep')
def run(args,**kw):
    assert args[:3]==['aws','logs','filter-log-events']
    assert args[args.index('--profile')+1]=='esgiot-readonly'
    assert args[args.index('--region')+1]=='ap-southeast-1'
    active[0]+=1;peak[0]=max(peak[0],active[0]);active[0]-=1
    gateway='/apigateway/' in args[args.index('--log-group-name')+1]
    pattern=args[args.index('--filter-pattern')+1] if '--filter-pattern' in args else None
    token=args[args.index('--next-token')+1] if '--next-token' in args else None
    calls.append({'gateway':gateway,'invocations':pattern.strip('%').split('|') if pattern else [],'startMs':int(args[args.index('--start-time')+1]),'endMs':int(args[args.index('--end-time')+1]),'timeout':kw['timeout'],'token':bool(token)})
    if (fault=='partial-timeout' and len(calls)==3) or (fault=='wide-timeout' and len(calls)==1): raise subprocess.TimeoutExpired(args,kw['timeout'],stderr='PRIVATE_SENTINEL')
    if fault=='between-batches' and len(calls)==2: clock[0]=119
    if fault=='between-batches' and len(calls)==3: clock[0]=120
    events=[]
    for i,a in enumerate(attempts):
        o=a['observation'];rid=o['gatewayRequestId'];inv=records[i]['gateway'][0]['integrationRequestId']
        # Deliberately return other batches too: projection must keep only the current batch.
        value=records[i]['gateway'][0] if gateway else {'event':'admin.request.completed','gatewayRequestId':rid,'gatewayExtendedRequestId':'extended-'+rid,'lambdaRequestId':inv,'operationId':'updateContract','status':o['status'],'elapsedMs':30,'password':'PRIVATE_SENTINEL'}
        if fault=='duplicate' and not gateway: events.append({'message':json.dumps(value)})
        events.append({'message':json.dumps(value)})
    events.append({'message':'null'})
    events.append({'message':json.dumps({'requestId':[], 'gatewayRequestId':[]})})
    page={'events':events}
    if fault=='pagination' and not gateway:
        if not token: page={'events':[],'nextToken':'PRIVATE_SENTINEL'}
    return subprocess.CompletedProcess(args,0,json.dumps(page),'')
m.subprocess.run=run
flags=['--cold-sampling']
if fault not in ['wide','wide-timeout']: flags+=['--exact-from',prior,'--exact-sha256',expected]
if fault=='missing-hash': flags=flags[:-1]
if fault=='invalid-hash': flags[-1]='wrong'
if fault=='orphan-hash': flags=['--cold-sampling','--exact-sha256',expected]
script='scripts/collect-qa09-contract-correlation.py';sys.argv=[script,source,target]+flags
try:
    with contextlib.redirect_stdout(io.StringIO()): runpy.run_path(script,run_name='__main__')
    result=json.load(open(target));error=None
except ValueError as e: result=None;error=str(e)
print(json.dumps({'result':result,'error':error,'calls':calls,'peak':peak[0],'priorPreserved':Path(prior).read_bytes()==(before+b'\n' if fault=='prior-drift' else before),'outputPreserved':Path(target).read_text()=='keep' if fault=='overwrite' else True}))
`;
function collect(fault = '', count = 12) {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-log-budget-'));
  try {
    const source = join(dir, 'source.json');
    writeFileSync(
      source,
      JSON.stringify({
        prefix: 'qa09-1234567890abcdef',
        sourceCommit: 'test',
        fullQa09Accepted: false,
        checks: [],
        cold409Sampling: {
          gate: 'PASS',
          attempts: Array.from({ length: count }, (_, i) => ({
            id: 'cold-' + i,
            observation: {
              gatewayRequestId: 'request-' + i,
              gatewayExtendedRequestId: 'extended-request-' + i,
              method: 'PATCH',
              startedAt: '2026-10-06T05:20:00.000Z',
              latencyMs: 100,
              responseReceived: true,
              status: i % 2 ? 409 : 200,
            },
          })),
        },
      }),
    );
    const r = python(collectorWrapper, [source, join(dir, 'prior.json'), join(dir, 'output.json'), fault]);
    if (r.result?.gate === 'PASS') {
      const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
      assert.equal(
        checkLogReadBudget(r.result, {
          sourceSha256: hashFile(source),
          collectorSha256: hashFile('scripts/collect-qa09-contract-correlation.py'),
          readerSha256: hashFile('scripts/qa09_log_read.py'),
          projectorSha256: hashFile('scripts/qa09_observer_cost.py'),
          ...(r.result.readOptimization ? { priorSha256: hashFile(join(dir, 'prior.json')) } : {}),
        }).gate,
        'PASS',
      );
    }
    evidence('collector-' + (fault || 'success') + '-' + count, r);
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const count of [6, 12, 19]) {
  test(`actual exact collector reads ${count} invocations once in serial batches of at most three`, () => {
    const r = collect('', count);
    assert.equal(r.result.gate, 'PASS');
    assert.equal(r.result.exactLinkedCount, count);
    assert.equal(r.calls.length, 1 + Math.ceil(count / 3));
    assert.equal(r.peak, 1);
    const batches = r.calls.slice(1).map((c) => c.invocations);
    assert.ok(batches.every((b) => b.length > 0 && b.length <= 3));
    assert.equal(new Set(batches.flat()).size, count);
    assert.equal(batches.flat().length, count);
    assert.ok(r.calls.every((c) => c.startMs === 1791263998000 && c.endMs === 1791264032000));
    assert.equal(
      r.result.readOptimization.expectedPriorReceiptSha256,
      r.result.readOptimization.priorGatewayReceiptSha256,
    );
    assert.match(r.result.readerSha256, /^[a-f0-9]{64}$/);
    assert.ok(r.priorPreserved);
  });
}
test('actual collector paginates each batch before advancing to the next, without duplicates', () => {
  const r = collect('pagination');
  assert.equal(r.result.gate, 'PASS');
  assert.equal(r.calls.length, 9);
  for (let i = 1; i < 9; i += 2) {
    assert.equal(r.calls[i].token, false);
    assert.equal(r.calls[i + 1].token, true);
    assert.deepEqual(r.calls[i].invocations, r.calls[i + 1].invocations);
  }
});
for (const fault of ['partial-timeout', 'between-batches']) {
  test('actual collector retains first batch and all request rows after ' + fault, () => {
    const r = collect(fault);
    assert.equal(r.result.gate, 'PARTIAL');
    assert.equal(r.result.records.length, 12);
    assert.equal(r.result.exactLinkedCount, 3);
    assert.equal(r.calls.length, 3);
    assert.equal(
      r.result.logReadErrors.lambda,
      fault === 'partial-timeout' ? 'LOG_READ_TIMEOUT' : 'LOG_TOTAL_DEADLINE_EXCEEDED',
    );
    assert.ok(r.priorPreserved);
    if (fault === 'between-batches') assert.equal(r.calls.at(-1).timeout, 1);
  });
}
for (const [fault, error] of [
  ['prior-drift', 'PRIOR_RECEIPT_BYTES_DRIFT'],
  ['source-drift', 'PRIOR_GATEWAY_BINDING_REQUIRED'],
  ['missing-hash', 'EXACT_EXPECTED_HASH_REQUIRED'],
  ['invalid-hash', 'EXACT_EXPECTED_HASH_REQUIRED'],
  ['orphan-hash', 'EXACT_EXPECTED_HASH_REQUIRED'],
  ['overwrite', 'OUTPUT_ALREADY_EXISTS'],
]) {
  test('actual collector rejects ' + fault + ' before any AWS read', () => {
    const r = collect(fault);
    assert.equal(r.error, error);
    assert.equal(r.result, null);
    assert.equal(r.calls.length, 0);
    assert.ok(r.priorPreserved && r.outputPreserved);
  });
}
test('duplicate Lambda completion remains PARTIAL with bounded reads', () => {
  const r = collect('duplicate');
  assert.equal(r.result.gate, 'PARTIAL');
  assert.equal(r.result.exactLinkedCount, 0);
  assert.equal(r.result.logReadBudget.error, null);
});
test('ordinary collection also reports the shared budget without exact filters', () => {
  const r = collect('wide');
  assert.equal(r.result.gate, 'PASS');
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every((c) => c.invocations.length === 0));
  assert.equal(r.result.logReadBudget.maxCalls, 40);
});

test('ordinary collector stops after gateway timeout and marks Lambda not started', () => {
  const r = collect('wide-timeout');
  assert.equal(r.result.gate, 'PARTIAL');
  assert.equal(r.calls.length, 1);
  assert.equal(r.result.logReadErrors.gateway, 'LOG_READ_TIMEOUT');
  assert.equal(r.result.logReadErrors.lambda, 'LOG_READ_NOT_STARTED');
  assert.equal(r.result.records.length, 12);
});
