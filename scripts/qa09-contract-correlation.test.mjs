import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const fakeLogs = `
import json,sys,subprocess,runpy,datetime
script,source,output,fault=sys.argv[1:]
r=json.load(open(source)); attempts=r['remaining']['attempts']; audit_mode=fault.startswith('audit-')
def logs(args,**kwargs):
    gateway=args[args.index('--log-group-name')+1].startswith('/aws/apigateway/')
    events=[]
    for a in attempts:
        o=a['observation']; epoch=int(datetime.datetime.fromisoformat(o['startedAt'].replace('Z','+00:00')).timestamp()*1000)
        if gateway:
            value={'requestId':(o.get('gatewayRequestId') or a['clientRequestId']),'extendedRequestId':o['gatewayExtendedRequestId'],
                   'integrationRequestId':'lambda-'+a['id'],'requestTimeEpoch':str(epoch),
                   'httpMethod':'GET' if audit_mode else 'PATCH','status':str(o.get('status') or 200),'integrationStatus':'200','functionStatus':str(o.get('status') or 200)}
            if fault=='time': value['requestTimeEpoch']='1'
        else:
            value={'event':'admin.request.completed','gatewayRequestId':(o.get('gatewayRequestId') or a['clientRequestId']),
                   'gatewayExtendedRequestId':o['gatewayExtendedRequestId'],'lambdaRequestId':'lambda-'+a['id'],
                   'operationId':('listAuditLogs' if a['id']=='race:audit-list' else 'getAuditLogDetail') if audit_mode else 'updateContract','status':o.get('status') or 200,'body':'SENSITIVE_SENTINEL'}
            if fault=='lambda-id': value['lambdaRequestId']='unrelated'
        events.append({'message':json.dumps(value)})
        if fault=='duplicate' and gateway: events.append({'message':json.dumps(value)})
    events.append({'message':json.dumps({'requestId':'foreign','body':'SENSITIVE_SENTINEL'})})
    return subprocess.CompletedProcess(args,0,json.dumps({'events':events}),'')
subprocess.run=logs
sys.argv=[script,source,output]+(['--audit-get'] if audit_mode else [])
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
    if (fault.startsWith('audit-')) {
      const value = JSON.parse(readFileSync(input, 'utf8'));
      value.remaining.attempts = value.remaining.attempts.slice(0, 2).map((a, i) => {
        a.id = i ? 'race:audit-detail:own:sample-1' : 'race:audit-list';
        a.observation.method = 'GET';
        a.observation.id = a.id;
        a.observation.clientRequestId = a.clientRequestId;
        a.observation.status = 200;
        if (fault === 'audit-timeout' && i) {
          delete a.observation.status;
          delete a.observation.gatewayRequestId;
          a.observation.responseReceived = false;
        }
        return a;
      });
      value.checks = value.remaining.attempts.map((a) => a.observation);
      writeFileSync(input, JSON.stringify(value));
    }
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

test('audit GET binds list/detail operation and timeout UUID without claiming client success', () => {
  const success = collect('audit-success');
  assert.equal(success.gate, 'PASS');
  assert.equal(success.exactLinkedCount, 2);
  const timeout = collect('audit-timeout');
  assert.equal(timeout.gate, 'PARTIAL');
  assert.equal(timeout.exactLinkedCount, 2);
  assert.equal(timeout.records[1].responseReceived, false);
  assert.equal(timeout.records[1].gateway[0].status, '200');
});
