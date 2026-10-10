import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const wrapper = String.raw`
import sys,json,subprocess,runpy,contextlib,io
script,source,output,mode,fault=sys.argv[1:]; calls=[]
receipt=json.load(open(source)); audit=mode=='audit'; cold=mode!='baseline'
attempts=receipt['checks'] if audit else receipt['cold409Sampling' if cold else 'remaining']['attempts']
def logs(args,**kwargs):
    assert args[:3]==['aws','logs','filter-log-events']
    gateway='/apigateway/' in args[args.index('--log-group-name')+1]
    calls.append({'gateway':gateway,'exactFilter':'--filter-pattern' in args})
    events=[]
    for i,a in enumerate(attempts):
        o=a.get('observation',a); rid=o['gatewayRequestId']; inv='10000000-0000-4000-8000-'+str(i).zfill(12)
        common={'gatewayRequestId':rid,'lambdaRequestId':inv,'operationId':('listAuditLogs' if a['id'].endswith(':list') else 'getAuditLogDetail') if audit else 'updateContract'}
        if gateway:
            value={'requestId':rid,'extendedRequestId':'extended-'+rid,'integrationRequestId':inv,'requestTimeEpoch':'1791264000000','httpMethod':'GET' if audit else 'PATCH','status':str(o['status']),'integrationStatus':'200','functionStatus':str(o['status'])}
        else:
            value={**common,'event':'admin.request.completed','gatewayExtendedRequestId':'extended-'+rid,'status':o['status'],'elapsedMs':30,'password':'PRIVATE_SENTINEL'}
            for boundary in ['CALL_RETURNED','DRIVER_DISPATCH','PG_DISPATCH','PG_SETTLED','OPERATION_SETTLED','ADAPTER_CALL_RETURNED','PG_CALL_RETURNED','MODEL_EXTENSION_RESUMED']:
                events.append({'message':json.dumps({**common,'event':'data-path.phase.completed','phase':'contract-load-driver-pg','completionBoundary':boundary,'processCpuScope':'PROCESS_ALL_THREADS','processCpuUserUs':120,'processCpuSystemUs':30,'password':'PRIVATE_SENTINEL'})})
            events.append({'message':json.dumps({**common,'event':'data-path.phase.completed','phase':'bad-optional','completionBoundary':'PRIVATE_SENTINEL','processCpuScope':'PRIVATE_SENTINEL','processCpuUserUs':True})})
            events.append({'message':json.dumps({**common,'event':'data-path.contract-load.ownership','modelEntries':1,'driverDispatches':1,'transactional':True,'detailEnabled':True,'pgQueries':1,'pgSettlements':1,'publicBoundariesEnabled':True,'modelResumeObserved':True,'driverReturns':1,'pgReturns':1,'modelResumes':1,'password':'PRIVATE_SENTINEL'})})
            events.append({'message':'REPORT RequestId: '+inv+'\tDuration: 30.5 ms\tMemory Size: 512 MB\tInit Duration: 20 ms'})
        events.append({'message':json.dumps(value)})
    return subprocess.CompletedProcess(args,0,json.dumps({'events':events}),'')
subprocess.run=logs
flags=(['--cold-sampling'] if cold else [])+(['--audit-get'] if audit else [])
sys.argv=[script,source,output]+flags
with contextlib.redirect_stdout(io.StringIO()): runpy.run_path(script,run_name='__main__')
normal=json.load(open(output)); prior=normal
if fault=='source': prior['sourceReceiptSha256']='wrong'
if fault=='time': prior['records'][0]['gateway'][0]['requestTimeEpoch']='1'
if fault=='duplicate': prior['records'][0]['gateway']*=2
if fault=='id': prior['records'][0]['gateway'][0]['integrationRequestId']='arbitrary'
if fault=='shared': prior['records'][1]['gateway'][0]['integrationRequestId']=prior['records'][0]['gateway'][0]['integrationRequestId']
if fault=='extended': prior['records'][0]['gateway'][0]['extendedRequestId']='wrong'
json.dump(prior,open(output,'w'))
if fault=='raw-bytes': open(source,'a').write('\n')
before=open(output,'rb').read(); target=output if fault=='overwrite' else output+'.exact'
sys.argv=[script,source,target]+flags+['--exact-from',output]
try:
    with contextlib.redirect_stdout(io.StringIO()): runpy.run_path(script,run_name='__main__')
    exact=json.load(open(target)); error=None
except ValueError as e: exact=None; error=str(e)
print(json.dumps({'normal':normal,'exact':exact,'error':error,'calls':calls,'priorUnchanged':open(output,'rb').read()==before}))
`;
function collect(mode, fault = '') {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-exact-correlation-'));
  try {
    const rows = Array.from(
      { length: fault === 'over-limit' ? 20 : mode === 'audit' ? 18 : mode === 'cold' ? 12 : 6 },
      (_, i) => {
        const rid = String(i).padStart(8, '0') + '-0000-4000-8000-000000000000';
        const id = mode === 'audit' ? 'cold:audit:' + i + (i % 3 === 0 ? ':list' : '') : 'race-' + i;
        const observation = {
          method: mode === 'audit' ? 'GET' : 'PATCH',
          gatewayRequestId: rid,
          gatewayExtendedRequestId: 'extended-' + rid,
          startedAt: '2026-10-06T05:20:00.000Z',
          latencyMs: 100,
          responseReceived: true,
          status: mode === 'audit' || i % 2 === 0 ? 200 : 409,
        };
        return mode === 'audit' ? { id, ...observation } : { id, observation };
      },
    );
    const source = join(dir, 'source.json'),
      output = join(dir, 'output.json');
    writeFileSync(
      source,
      JSON.stringify({
        prefix: 'qa09-1234567890abcdef',
        sourceCommit: 'test',
        fullQa09Accepted: false,
        remaining: { attempts: mode === 'baseline' ? rows : [] },
        cold409Sampling: { gate: 'PASS', attempts: mode === 'cold' ? rows : [] },
        checks: mode === 'audit' ? rows : [],
      }),
    );
    const q = spawnSync(
      'python3',
      ['-c', wrapper, 'scripts/collect-qa09-contract-correlation.py', source, output, mode, fault],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(q.status, 0, q.stderr);
    assert.ok(!q.stdout.includes('PRIVATE_SENTINEL'));
    return JSON.parse(q.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const mode of ['baseline', 'cold', 'audit'])
  test(mode + ' normal/exact collection shares every ownership/PG/CPU field without business requests', () => {
    const r = collect(mode);
    assert.equal(r.exact.gate, 'PASS');
    assert.equal(r.exact.records.length, mode === 'audit' ? 18 : mode === 'cold' ? 12 : 6);
    assert.deepEqual(r.exact.records, r.normal.records);
    const row = r.exact.records[0];
    assert.equal(row.contractLoadOwnership[0].detailEnabled, true);
    assert.equal(row.contractLoadOwnership[0].pgQueries, 1);
    assert.equal(row.contractLoadOwnership[0].pgSettlements, 1);
    for (const key of ['driverReturns', 'pgReturns', 'modelResumes'])
      assert.equal(row.contractLoadOwnership[0][key], 1);
    assert.equal(row.contractLoadOwnership[0].publicBoundariesEnabled, true);
    assert.equal(row.contractLoadOwnership[0].modelResumeObserved, true);
    for (const boundary of ['ADAPTER_CALL_RETURNED', 'PG_CALL_RETURNED', 'MODEL_EXTENSION_RESUMED'])
      assert.ok(row.phases.some((p) => p.completionBoundary === boundary));
    assert.ok(row.phases.some((p) => p.completionBoundary === 'PG_DISPATCH'));
    assert.ok(row.phases.some((p) => p.completionBoundary === 'PG_SETTLED'));
    assert.equal(row.phases.at(-1).completionBoundary, undefined);
    assert.equal(row.phases.at(-1).processCpuUserUs, undefined);
    assert.deepEqual(r.calls, [
      { gateway: true, exactFilter: false },
      { gateway: false, exactFilter: false },
      { gateway: true, exactFilter: false },
      { gateway: false, exactFilter: true },
    ]);
    assert.ok(r.priorUnchanged);
  });
for (const fault of ['source', 'raw-bytes', 'time', 'duplicate', 'id', 'shared', 'extended', 'overwrite', 'over-limit'])
  test('exact collection rejects ' + fault + ' before another AWS read and preserves prior bytes', () => {
    const r = collect('baseline', fault);
    assert.ok(r.error);
    assert.equal(r.exact, null);
    assert.equal(r.calls.length, 2);
    assert.ok(r.priorUnchanged);
  });
