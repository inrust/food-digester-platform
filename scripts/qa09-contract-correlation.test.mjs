import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const fakeLogs = `
import json,sys,subprocess,runpy,datetime
script,source,output,fault=sys.argv[1:]
r=json.load(open(source)); attempts=r['remaining']['attempts']
def logs(args,**kwargs):
    gateway=args[args.index('--log-group-name')+1].startswith('/aws/apigateway/')
    events=[]
    for a in attempts:
        o=a['observation']; epoch=int(datetime.datetime.fromisoformat(o['startedAt'].replace('Z','+00:00')).timestamp()*1000)
        if gateway:
            value={'requestId':o['gatewayRequestId'],'extendedRequestId':o['gatewayExtendedRequestId'],
                   'integrationRequestId':'lambda-'+a['id'],'requestTimeEpoch':str(epoch),
                   'httpMethod':'PATCH','status':str(o['status']),'integrationStatus':'200','functionStatus':str(o['status'])}
            if fault=='time': value['requestTimeEpoch']='1'
        else:
            value={'event':'admin.request.completed','gatewayRequestId':o['gatewayRequestId'],
                   'gatewayExtendedRequestId':o['gatewayExtendedRequestId'],'lambdaRequestId':'lambda-'+a['id'],
                   'operationId':'updateContract','status':o['status'],'body':'SENSITIVE_SENTINEL'}
            if fault=='lambda-id': value['lambdaRequestId']='unrelated'
        events.append({'message':json.dumps(value)})
        if fault=='duplicate' and gateway: events.append({'message':json.dumps(value)})
    events.append({'message':json.dumps({'requestId':'foreign','body':'SENSITIVE_SENTINEL'})})
    return subprocess.CompletedProcess(args,0,json.dumps({'events':events}),'')
subprocess.run=logs
sys.argv=[script,source,output]
runpy.run_path(script,run_name='__main__')
`;
function collect(fault) {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-contract-correlation-'));
  try {
    const input = join(dir, 'input.json'),
      output = join(dir, 'output.json');
    writeFileSync(
      input,
      JSON.stringify({
        prefix: 'qa09-1234567890abcdef',
        fullQa09Accepted: false,
        remaining: {
          attempts: Array.from({ length: 6 }, (_, i) => ({
            id: 'race-' + i,
            clientRequestId: `${i}0000000-0000-4000-8000-000000000000`,
            observation: {
              startedAt: '2026-10-06T01:00:00.000Z',
              latencyMs: 100,
              status: i % 2 ? 409 : 200,
              gatewayRequestId: `${i}0000000-0000-4000-8000-000000000000`,
              gatewayExtendedRequestId: 'extended-' + i,
              responseReceived: fault !== 'missing-http',
            },
          })),
        },
      }),
    );
    const result = spawnSync(
      'python3',
      ['-c', fakeLogs, 'scripts/collect-qa09-contract-correlation.py', input, output, fault],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const raw = readFileSync(output, 'utf8');
    assert.ok(!raw.includes('SENSITIVE_SENTINEL'));
    assert.ok(!raw.includes('foreign'));
    return JSON.parse(raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('six exact request/time/status/extended/Lambda links pass without saving unrelated fields or requests', () => {
  const r = collect('none');
  assert.equal(r.gate, 'PASS');
  assert.equal(r.exactLinkedCount, 6);
});
for (const fault of ['time', 'lambda-id', 'duplicate', 'missing-http'])
  test('correlation refuses complete proof for ' + fault, () => assert.equal(collect(fault).gate, 'PARTIAL'));
