import json, re, subprocess, hashlib
from pathlib import Path
from datetime import datetime
root = Path(__file__).parent
parent_bytes = (root/'sample.json.fixtures.json').read_bytes()
child_bytes = (root/'sample.json').read_bytes()
parent, child = json.loads(parent_bytes), json.loads(child_bytes)
assert parent['prefix'] == child['prefix'] and parent['sourceCommit'] == child['sourceCommit'] == 'de4c2f6ab94462fb684a5e117edb474d42df035c'
uuid = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
ids = []
for row in parent['checks'] + child['checks']:
    request_id = row.get('requestId') or row.get('gatewayRequestId')
    if isinstance(request_id, str) and uuid.fullmatch(request_id) and request_id not in ids:
        ids.append(request_id)
    if len(ids) == 8: break
assert ids
start = int(datetime.fromisoformat(parent['startedAt'].replace('Z','+00:00')).timestamp()*1000)-2000
end = int(datetime.fromisoformat(parent['finishedAt'].replace('Z','+00:00')).timestamp()*1000)+120000
assert 0 < end-start < 3600000
fields = ['lambdaRequestId','gatewayRequestId','gatewayExtendedRequestId','operationId','phase','durationMs','outcome','errorCode','startedAt','completedAt','coldStart','includesConnectionWait','completionBoundary','processCpuUserUs','processCpuSystemUs','processCpuScope','elapsedMs','status','event']
def logs(pattern, group="/aws/lambda/fdp-test-api"):
    token, seen, result = None, set(), []
    for _ in range(20):
        args = ['aws','logs','filter-log-events','--log-group-name',group,'--start-time',str(start),'--end-time',str(end),'--filter-pattern',pattern,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager']
        if token: args += ['--next-token',token]
        p = subprocess.run(args,capture_output=True,text=True,timeout=45)
        if p.returncode: raise RuntimeError('INITIAL_PHASE_LOG_READ_FAILED')
        page = json.loads(p.stdout); result.extend(page.get('events',[])); token = page.get('nextToken')
        if not token: return result
        if token in seen: raise RuntimeError('INITIAL_PHASE_REPEATED_TOKEN')
        seen.add(token)
    raise RuntimeError('INITIAL_PHASE_PAGES_EXHAUSTED')
records = []
for rid in ids:
    gateway = []
    for event in logs('{ $.requestId = "'+rid+'" }', '/aws/apigateway/fdp-test-admin-api-access'):
        text = event.get('message','')
        try: g = json.loads(text[text.find('{'):])
        except (ValueError,TypeError): continue
        if g.get('requestId') == rid:
            gateway.append({k:g[k] for k in ['requestId','extendedRequestId','integrationRequestId','requestTimeEpoch','httpMethod','status','integrationStatus','functionStatus','integrationLatency','responseLatency'] if k in g})
    if len(gateway) != 1: raise RuntimeError('INITIAL_GATEWAY_NOT_UNIQUE')
    rows = []
    for event in logs('{ $.gatewayRequestId = "'+rid+'" }'):
        text = event.get('message','')
        try: v = json.loads(text[text.find('{'):])
        except (ValueError,TypeError): continue
        if v.get('gatewayRequestId') != rid or v.get('event') not in ['data-path.phase.completed','admin.request.completed']: continue
        if not uuid.fullmatch(v.get('lambdaRequestId','')): raise RuntimeError('INITIAL_INVOCATION_INVALID')
        rows.append({k:v[k] for k in fields if k in v})
    invocations = sorted(set(r['lambdaRequestId'] for r in rows))
    if len(invocations) != 1: raise RuntimeError('INITIAL_INVOCATION_NOT_UNIQUE')
    invocation = invocations[0]; reports = []
    completion = [r for r in rows if r['event']=='admin.request.completed']
    if len(completion) != 1 or gateway[0].get('integrationRequestId') != invocation or gateway[0].get('extendedRequestId') != completion[0].get('gatewayExtendedRequestId') or str(gateway[0].get('status')) != str(completion[0].get('status')): raise RuntimeError('INITIAL_GATEWAY_LAMBDA_MISMATCH')
    for event in logs('"'+invocation+'"'):
        text = event.get('message','')
        found = re.search(r'REPORT RequestId:\s*([a-f0-9-]{36})',text)
        if not found or found.group(1) != invocation: continue
        report = {'lambdaRequestId':invocation}
        for label,key in [('Duration','durationMs'),('Init Duration','initDurationMs'),('Memory Size','memoryMiB'),('Max Memory Used','maxMemoryMiB')]:
            match = re.search(r'(?:^|\t)'+label+r':\s*([0-9.]+)\s*(?:ms|MB)',text)
            if match: report[key] = float(match.group(1))
        reports.append(report)
    if len(reports) != 1: raise RuntimeError('INITIAL_REPORT_NOT_UNIQUE')
    records.append({'requestId':rid,'lambdaRequestId':invocation,'phases':[r for r in rows if r['event']=='data-path.phase.completed'],'completion':[r for r in rows if r['event']=='admin.request.completed'],'platformReports':reports,'gateway':gateway})
result = {'scope':'OWN_FIRST_EIGHT_INITIALIZATION_REQUESTS_EXACT_INVOCATIONS','sourceCommit':child['sourceCommit'],'prefix':child['prefix'],'gate':'PASS','records':records,'p95Accepted':False,'bindings':{'parentSha256':hashlib.sha256(parent_bytes).hexdigest(),'childSha256':hashlib.sha256(child_bytes).hexdigest(),'collectorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}}
(root/'initial-phases.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'gate':'PASS','requests':len(records)}))
