import json, re, subprocess, hashlib
from pathlib import Path
from datetime import datetime
import sys
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[5]/"scripts"))
from qa09_log_read import LogReader
if sys.argv[1:]==['--check-import']:
    print(json.dumps({'gate':'PASS','modulePath':str(Path(sys.modules['qa09_log_read'].__file__).resolve()),'readerSha256':hashlib.sha256(Path(sys.modules['qa09_log_read'].__file__).read_bytes()).hexdigest()}))
    raise SystemExit(0)
root = Path(__file__).parent
assert not (root/'negative-phases.json').exists(), 'PRESERVE_ORIGINAL_AUXILIARY_OUTPUT'
child_bytes = (root/'negative-get.json').read_bytes()
child=json.loads(child_bytes)
assert child['sourceCommit']=='ebbcfc0ee31673b3332b217ca757e6aa1ea6013d' and len(child['rows'])==12 and child['gate']=='PASS'
uuid=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
ids=[r['gatewayRequestId'] for r in child['rows']]
assert len(set(ids))==12 and all(uuid.fullmatch(i) for i in ids)
start=int(datetime.fromisoformat(child['startedAt'].replace('Z','+00:00')).timestamp()*1000)-2000
end=int(datetime.fromisoformat(child['finishedAt'].replace('Z','+00:00')).timestamp()*1000)+120000
assert 0<end-start<600000
fields = ['lambdaRequestId','gatewayRequestId','gatewayExtendedRequestId','operationId','phase','durationMs','outcome','errorCode','startedAt','completedAt','coldStart','includesConnectionWait','completionBoundary','processCpuUserUs','processCpuSystemUs','processCpuScope','elapsedMs','status','event']
reader=LogReader()
queryNumbers={'gateway':0,'lambda':0}
def logs(pattern, group="/aws/lambda/fdp-test-api"):
    name='gateway' if '/apigateway/' in group else 'lambda'
    query=queryNumbers[name];queryNumbers[name]+=1
    result=[]
    for page in reader.pages(name,group,start,end,pattern,query): result.extend(page['events'])
    if reader.error:
        output=root/"negative-phases.json"
        assert not output.exists(), 'PRESERVE_ORIGINAL_READ_RECEIPT'
        output.write_text(json.dumps({'gate':'PARTIAL','sourceCommit':child['sourceCommit'],
            'scope':'OWN_AUXILIARY_READ_STOPPED','records':records,'logReadErrors':dict(reader.group_errors),
            'logReadBudget':reader.finish(),'readerSha256':hashlib.sha256((Path(__file__).resolve().parents[5]/'scripts/qa09_log_read.py').read_bytes()).hexdigest(),
            'fullQa09Accepted':False},indent=2)+'\n')
        raise RuntimeError(reader.error)
    return result
records = []
for rid in ids:
    gateway = []
    for event in logs('{ $.requestId = "'+rid+'" }', '/aws/apigateway/fdp-test-admin-api-access'):
        text = event.get('message','')
        try: g = json.loads(text[text.find('{'):])
        except (ValueError,TypeError): continue
        if g.get('requestId') == rid:
            gateway.append({k:g[k] for k in ['requestId','extendedRequestId','integrationRequestId','requestTimeEpoch','httpMethod','status','integrationStatus','functionStatus','integrationLatency','responseLatency','errorResponseType'] if k in g})
    if len(gateway) != 1: raise RuntimeError('INITIAL_GATEWAY_NOT_UNIQUE')
    client=next(r for r in child['rows'] if r['gatewayRequestId']==rid)
    client_ms=int(datetime.fromisoformat(client['startedAt'].replace('Z','+00:00')).timestamp()*1000)
    assert gateway[0]['httpMethod']=='GET' and str(gateway[0]['status'])=='401'
    assert client_ms-2000<=int(gateway[0]['requestTimeEpoch'])<=client_ms+client['latencyMs']+2000
    assert not client.get('gatewayExtendedRequestId') or gateway[0]['extendedRequestId']==client['gatewayExtendedRequestId']
    rows = []
    for event in logs('{ $.gatewayRequestId = "'+rid+'" }'):
        text = event.get('message','')
        try: v = json.loads(text[text.find('{'):])
        except (ValueError,TypeError): continue
        if v.get('gatewayRequestId') != rid or v.get('event') not in ['data-path.phase.completed','admin.request.completed']: continue
        if not uuid.fullmatch(v.get('lambdaRequestId','')): raise RuntimeError('INITIAL_INVOCATION_INVALID')
        rows.append({k:v[k] for k in fields if k in v})
    if gateway[0].get('integrationRequestId')=='-' and gateway[0].get('integrationStatus')=='-' and gateway[0].get('functionStatus')=='-':
        assert gateway[0].get('errorResponseType')=='UNAUTHORIZED' and not rows,'GATEWAY_REJECTION_HAS_LAMBDA_EVENTS'
        records.append({'requestId':rid,'lambdaRequestId':None,'phases':[],'completion':[],'platformReports':[],'gateway':gateway,'boundary':'COGNITO_AUTHORIZER_REJECTED_BEFORE_LAMBDA','exactOwnLambdaLogMatches':0})
        continue
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
readBudget=reader.finish()
result = {'logReadBudget':readBudget,'logReadErrors':dict(reader.group_errors),'readerSha256':hashlib.sha256((Path(__file__).resolve().parents[5]/'scripts/qa09_log_read.py').read_bytes()).hexdigest(),'scope':'OWN_TWELVE_NEGATIVE_GET_EXACT_INVOCATIONS','sourceCommit':child['sourceCommit'],'gate':'PARTIAL' if reader.error else 'PASS','records':records,'p95Accepted':False,'bindings':{'childSha256':hashlib.sha256(child_bytes).hexdigest(),'collectorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}}
(root/'negative-phases.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'gate':result['gate'],'requests':len(records)}))

assert not reader.error, 'AUXILIARY_TOTAL_DEADLINE'
