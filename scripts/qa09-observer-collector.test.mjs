import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const wrapper = String.raw`
import sys,json,subprocess,runpy,contextlib,io
script,source,output,fault=sys.argv[1:];receipt=json.load(open(source));calls=[]
def logs(args,**kw):
    assert args[:3]==['aws','logs','filter-log-events']
    gateway='/apigateway/' in args[args.index('--log-group-name')+1];calls.append({'gateway':gateway,'exact':'--filter-pattern' in args});events=[]
    for i,a in enumerate(receipt['remaining']['attempts']):
        c=a['observation'];rid=c['gatewayRequestId'];inv='10000000-0000-4000-8000-'+str(i).zfill(12)
        if gateway:
            row={'requestId':rid,'extendedRequestId':'ext-'+rid,'integrationRequestId':inv,'requestTimeEpoch':1791264000000,'httpMethod':'PATCH','status':c['status'],'integrationStatus':'200','functionStatus':c['status']}
        else:
            common={'gatewayRequestId':rid,'lambdaRequestId':inv,'operationId':'updateContract'}
            row={**common,'event':'admin.request.completed','gatewayExtendedRequestId':'ext-'+rid,'status':c['status'],'elapsedMs':30}
            cost={**common,'event':'data-path.contract-load.observer-cost','schemaVersion':1,'status':'COMPLETE','intervalRecords':19,'publicCalls':1,'publicOutcome':'RETURNED','overflow':0,'nestedOutputs':0,'foreignOutputs':0,'probeFailures':0,'outsideOutputs':12,'ambiguousOutputs':0,'unresolvedOutputs':0,'processCpuScope':'PROCESS_ALL_THREADS','cpuSubtractionAllowed':False,'compilerOnlyAttribution':False,'segments':[{'name':name,'wallUs':100,'outputWallUs':10,'outputProcessCpuUs':20,'unattributedWallUs':90,'password':'PRIVATE_SENTINEL'} for name in ['driver-prefix','public-call','driver-return-tail','after-model']],'password':'PRIVATE_SENTINEL'}
            if fault.startswith('owned') and fault != 'owned-legacy':
                cost['schemaVersion']=2
                cost['ownedBoundaries']={'seam':'SELF_OWNED_CALL_SITES','includesObservationOverhead':True,'afterQueueWallUs':30,'segments':[{'name':n,'wallUs':v,'password':'PRIVATE_SENTINEL'} for n,v in zip(['checkpoint-phase-setup','checkpoint-output-return','after-checkpoint-to-dispatch','repository-driver-setup','observer-public-bridge','public-callback-setup'],[10,10,10,40,60,10])],'password':'PRIVATE_SENTINEL'}
                if i==0:
                    own=cost['ownedBoundaries']
                    if fault=='owned-missing':own['segments'].pop()
                    if fault=='owned-duplicate':own['segments'][1]=own['segments'][0]
                    if fault=='owned-order':own['segments'].reverse()
                    if fault=='owned-conservation':own['afterQueueWallUs']=31
                    if fault=='owned-prefix':own['segments'][3]['wallUs']=41
                    if fault=='owned-callback':own['segments'][5]['wallUs']=101
                    if fault=='owned-bool':own['segments'][0]['wallUs']=True
                    if fault=='owned-claim':own['seam']='COMPILER_INTERNAL'
                    if fault=='owned-overhead':own['includesObservationOverhead']=False
            at=1791264000001
            if i==0:
                if fault=='foreign':cost['lambdaRequestId']='foreign'
                if fault=='operation':cost['operationId']='listAuditLogs'
                if fault=='time':at=1
                if fault=='schema':cost['publicCalls']=True
                if fault=='degraded':
                    cost['status']='OUTPUT_FAILED'
                    for segment in cost['segments']:segment['unattributedWallUs']=None
                if fault=='budget':cost['intervalRecords']=65
                if fault=='residual':cost['segments'][0]['unattributedWallUs']=99
                if fault=='duplicate-segment':cost['segments'][1]=cost['segments'][0]
            if i!=0 or fault!='missing':events.append({'timestamp':at,'message':json.dumps(cost)})
            if i==0 and fault=='duplicate':events.append({'timestamp':at,'message':json.dumps(cost)})
        events.append({'timestamp':1791264000001,'message':json.dumps(row)})
    return subprocess.CompletedProcess(args,0,json.dumps({'events':events}),'')
subprocess.run=logs
flags=['--observer-cost']+(['--owned-boundaries'] if fault.startswith('owned') else []);sys.argv=[script,source,output]+flags
with contextlib.redirect_stdout(io.StringIO()):runpy.run_path(script,run_name='__main__')
normal=json.load(open(output));sys.argv=[script,source,output+'.exact']+flags+['--exact-from',output]
with contextlib.redirect_stdout(io.StringIO()):runpy.run_path(script,run_name='__main__')
print(json.dumps({'normal':normal,'exact':json.load(open(output+'.exact')),'calls':calls}))
`;
function run(fault) {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-cost-collector-'));
  try {
    const source = join(dir, 'source.json'),
      output = join(dir, 'output.json');
    writeFileSync(
      source,
      JSON.stringify({
        prefix: 'qa09-1234567890abcdef',
        sourceCommit: 'a'.repeat(40),
        fullQa09Accepted: false,
        remaining: {
          attempts: Array.from({ length: 6 }, (_, i) => ({
            id: 'race-' + i,
            observation: {
              gatewayRequestId: 'request-' + i,
              gatewayExtendedRequestId: 'ext-request-' + i,
              method: 'PATCH',
              startedAt: '2026-10-06T05:20:00.000Z',
              latencyMs: 100,
              status: i % 2 ? 409 : 200,
              responseReceived: true,
            },
          })),
        },
      }),
    );
    const r = spawnSync(
      'python3',
      ['-c', wrapper, 'scripts/collect-qa09-contract-correlation.py', source, output, fault],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('PRIVATE_SENTINEL'));
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('normal and exact collectors share strict bounded observer projection and strip top-level/nested payloads', () => {
  const r = run('');
  assert.equal(r.normal.gate, 'PASS');
  assert.equal(r.exact.gate, 'PASS');
  assert.deepEqual(r.normal.records, r.exact.records);
  assert.equal(r.exact.records[0].contractObserverCost.length, 1);
  assert.deepEqual(r.calls, [
    { gateway: true, exact: false },
    { gateway: false, exact: false },
    { gateway: true, exact: false },
    { gateway: false, exact: true },
  ]);
});
for (const fault of [
  'missing',
  'duplicate',
  'foreign',
  'operation',
  'time',
  'schema',
  'degraded',
  'budget',
  'residual',
  'duplicate-segment',
])
  test('required observer collector retains PARTIAL for ' + fault, () => {
    const r = run(fault);
    assert.equal(r.normal.gate, 'PARTIAL');
    assert.equal(r.exact.gate, 'PARTIAL');
    assert.notEqual(r.exact.records[0].observerCostGate, 'PASS');
    assert.equal(r.exact.exactLinkedCount, 6);
  });

test('observer timestamp must belong to its own request window even within a wider batch window', () => {
  const code = `import sys
sys.dont_write_bytecode=True
sys.path.insert(0,'scripts')
from qa09_observer_cost import exact_observers
row={'gatewayRequestId':'g','lambdaRequestId':'l','operationId':'updateContract','logTimestampMs':60000}
assert exact_observers([row],[{'integrationRequestId':'l'}],[{'lambdaRequestId':'l'}],{'requestId':'g','operationId':'updateContract','startMs':10000,'latencyMs':100},0,100000)==[]
print('PASS')
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'PASS');
});

test('schema2 owned summary is projected identically by normal/exact collectors without payload leaks', () => {
  const r = run('owned');
  assert.equal(r.normal.gate, 'PASS');
  assert.equal(r.exact.gate, 'PASS');
  assert.equal(r.normal.ownedBoundariesRequired, true);
  assert.deepEqual(r.normal.records, r.exact.records);
  assert.equal(r.exact.records[0].contractObserverCost[0].ownedBoundaries.segments.length, 6);
});
for (const fault of [
  'legacy',
  'missing',
  'duplicate',
  'order',
  'conservation',
  'prefix',
  'callback',
  'bool',
  'claim',
  'overhead',
])
  test('schema2 required collection fails closed for ' + fault, () => {
    const r = run('owned-' + fault);
    assert.equal(r.normal.gate, 'PARTIAL');
    assert.equal(r.exact.gate, 'PARTIAL');
    assert.notEqual(r.exact.records[0].observerCostGate, 'PASS');
  });
