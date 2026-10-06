import json, hashlib, statistics, subprocess
from pathlib import Path
from datetime import datetime
r=Path(__file__).parent
bindings={}
def read(p):
 p=Path(p);b=p.read_bytes();bindings[str(p)]=hashlib.sha256(b).hexdigest();return json.loads(b)
def ms(s):return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
def stats(a):return {'min':round(min(a),3),'median':round(statistics.median(a),3),'max':round(max(a),3),'count':len(a)}
model=read(r/'model-comparison.json');tls=read(r/'tls-target.json');curl=read(r/'curl-target.json')
for d in [model,tls,curl]:
 assert d['gate']=='PASS' and d['p95Accepted'] is False
 for s in d['sources']:
  assert hashlib.sha256(Path(s['path']).read_bytes()).hexdigest()==s['sha256']
  if 'sourceBase64' in s:
   import base64
   assert base64.b64decode(s['sourceBase64'])==Path(s['path']).read_bytes()
assert len(model['rows'])==12 and model['budget']['network'] is False
models={}
for mode in ['lazy-full','engine-full','engine-select','engine-raw']:
 rows=[v for v in model['rows'] if v['mode']==mode];assert len(rows)==3 and sorted(v['index'] for v in rows)==[1,2,3]
 for v in rows:assert v['gate']=='PASS' and v['beforeQuery']=={'checkouts':0,'queries':0} and v['counts']=={'checkouts':3,'queries':3,'releases':3}
 models[mode]={n:stats([next(s['wallMs'] for s in v['spans'] if s['name']==n) for v in rows]) for n in ['first-account','next-full-model','warm-full-model']}
 models[mode]['engineAccountAndNextMs']=stats([sum(s['wallMs'] for s in v['spans'] if s['name']!='warm-full-model') for v in rows])
assert len(tls['rows'])==12 and tls['peakConcurrency']<=6 and tls['reuseComparisonGate']=='PASS' and tls['source']=='NODE_HTTPS_REAL_TARGET'
assert len(curl['rows'])==6 and curl['budget']=={'requests':6,'concurrency':1,'deadlineSeconds':20,'retries':0} and curl['source']=='CURL_REAL_TARGET'
for v in tls['rows']:assert v['status']==401 and v['tls']['authorized'] and v['clientTransport']['phase']=='COMPLETE'
for v in curl['rows']:assert v['status']==401 and v['sslVerifyResult']==0 and v['connections']==1
prior=Path('docs/audit/evidence/qa-09-54685cf-engine-cpu-target-2026-10-06'); cold=[]
for name in ['initial-phases.json','baseline-patch.json','sampling-patch.json']:
 d=read(prior/name);assert d['gate']=='PASS' and d['sourceCommit']=='54685cf26991682c8f9f22bde5b89b493377eed9'
 for row in d['records']:
  p={v['phase']:v for v in row['phases']}
  if 'runtime-initialize' not in p:continue
  a,b=p['runtime-database-secret'],p['runtime-license-secret'];cold.append({'receipt':name,'requestId':row['requestId'],'licenseAfterDatabaseMs':round(ms(b['completedAt'])-ms(a['completedAt'])),'runtimeAfterLastSecretMs':round(ms(p['runtime-initialize']['completedAt'])-max(ms(a['completedAt']),ms(b['completedAt']))),'note':'Timestamp intervals; durationMs rounding/capture differences are not normalized away.'})
assert len(cold)==3
summary={'gate':'PASS','scope':'PLAN_LOCAL_MODEL_COST_AND_INDEPENDENT_TRANSPORT_DIAGNOSIS','repositorySourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'historicalApplicationCommit':'54685cf26991682c8f9f22bde5b89b493377eed9','modelComparisons':models,'historicalColdDependencyWindows':cold,'nodeTiming':{k:stats([v['clientTransport'][k] for v in tls['rows'] if v['clientTransport'].get(k) is not None]) for k in ['dnsMs','tcpMs','tlsMs','responseWaitMs']},'curlTiming':{k:stats([v[k] for v in curl['rows']]) for k in ['dnsMs','tcpMs','tlsMs','responseWaitMs','totalMs']},'eventLoop':tls['eventLoop'],'p95Accepted':False,'fullQa09Accepted':False,'targetCandidateImplemented':False,'otherNetwork':'NOT_RUN_USER_CONFIRMED_UNAVAILABLE','networkRootCause':'UNDETERMINED','bindings':bindings}
(r/'analysis-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'gate':'PASS','offlineProcesses':12,'realUnauthenticatedGets':18,'targetCandidateImplemented':False,'p95Accepted':False}))
