import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const wrapper = `
import sys,json,subprocess,runpy,datetime
script,source,output,mode=sys.argv[1:]
r=json.load(open(source)); audit=mode=='audit'; rows=r['checks'] if audit else r['cold409Sampling']['attempts']
def logs(args,**kwargs):
    gateway='/apigateway/' in args[args.index('--log-group-name')+1]; events=[]
    for a in rows:
        o=a.get('observation',a); rid=o['gatewayRequestId']; invocation=o['invocation']; epoch=1791264000000
        if gateway:
            value={'requestId':rid,'extendedRequestId':'extended-'+rid,'integrationRequestId':invocation,'requestTimeEpoch':str(epoch),'httpMethod':'GET' if audit else 'PATCH','status':str(o['status']),'integrationStatus':'200','functionStatus':str(o['status'])}
        else:
            value={'event':'admin.request.completed','gatewayRequestId':rid,'gatewayExtendedRequestId':'extended-'+rid,'lambdaRequestId':invocation,'operationId':('listAuditLogs' if a['id'].endswith(':list') else 'getAuditLogDetail') if audit else 'updateContract','status':o['status'],'elapsedMs':30,'unsafe':'SECRET_SENTINEL'}
            events.append({'message':'REPORT RequestId: '+invocation+'\\tDuration: 30.50 ms\\tBilled Duration: 100 ms\\tMemory Size: 512 MB\\tMax Memory Used: 120 MB\\tInit Duration: 80.25 ms'})
        events.append({'message':json.dumps(value)})
    events.append({'message':'REPORT RequestId: 00000000-0000-0000-0000-000000000000\\tInit Duration: 999 ms'})
    return subprocess.CompletedProcess(args,0,json.dumps({'events':events}),'')
subprocess.run=logs
sys.argv=[script,source,output,'--cold-sampling']+(['--audit-get'] if audit else [])
runpy.run_path(script,run_name='__main__')
`;
function collect(audit) {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-cold-correlation-'));
  try {
    const rows = Array.from({ length: audit ? 18 : 12 }, (_, i) => {
      const requestId = randomUUID();
      const observation = {
        method: audit ? 'GET' : 'PATCH',
        gatewayRequestId: requestId,
        gatewayExtendedRequestId: 'extended-' + requestId,
        invocation: randomUUID(),
        startedAt: '2026-10-06T05:20:00.000Z',
        latencyMs: 100,
        responseReceived: true,
        status: audit || i % 2 === 0 ? 200 : 409,
        clientTransport: {
          source: 'NODE_HTTPS_SOCKET_EVENTS',
          dnsMs: null,
          tcpMs: 2,
          tlsMs: 3,
          bodyReadMs: 4,
          authorization: 'SECRET_SENTINEL',
          headers: { Authorization: 'SECRET_SENTINEL' },
        },
      };
      return audit
        ? { id: `cold:audit:${i}${i % 3 === 0 ? ':list' : ''}`, ...observation }
        : { id: 'cold:1:' + i, clientRequestId: requestId, startedAt: observation.startedAt, observation };
    });
    const source = join(dir, 'source.json'),
      output = join(dir, 'output.json'),
      fake = join(dir, 'fake.py');
    writeFileSync(
      source,
      JSON.stringify({
        prefix: 'qa09-1234567890abcdef',
        fullQa09Accepted: false,
        sourceCommit: 'test',
        cold409Sampling: { gate: 'PASS', attempts: audit ? [] : rows },
        checks: audit ? rows : [],
      }),
    );
    writeFileSync(fake, wrapper);
    const result = spawnSync(
      'python3',
      [fake, 'scripts/collect-qa09-contract-correlation.py', source, output, audit ? 'audit' : 'patch'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return { receipt: JSON.parse(readFileSync(output)), raw: readFileSync(output, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const audit of [false, true])
  test('cold sampler collector binds exact own REPORT and safe client metrics: ' + (audit ? 'audit' : 'patch'), () => {
    const { receipt, raw } = collect(audit);
    assert.equal(receipt.gate, 'PASS');
    assert.equal(receipt.exactLinkedCount, audit ? 18 : 12);
    assert.ok(receipt.scope.startsWith('OWN_COLD409_'));
    assert.equal(raw.includes('SECRET_SENTINEL'), false);
    assert.equal(
      receipt.records.some((row) => row.platformReports.some((report) => report.initDurationMs === 999)),
      false,
    );
    for (const row of receipt.records) {
      assert.equal(row.platformReports.length, 1);
      assert.equal(row.platformReports[0].lambdaRequestId, row.lambda[0].lambdaRequestId);
      assert.equal(row.platformReports[0].initDurationMs, 80.25);
      assert.equal(row.platformReports[0].memoryMiB, 512);
      assert.equal(row.clientTransport.bodyReadMs, 4);
      assert.equal(row.clientTransport.dnsMs, null);
    }
  });
