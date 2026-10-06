import json, hashlib
from pathlib import Path
from datetime import datetime
r=Path(__file__).parent
bindings={}
def read(n):
 b=(r/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
def ms(s):return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
initial=read('initial-phases.json');parent=read('sample.json.fixtures.json');child=read('sample.json');assert initial['gate']=='PASS' and initial['bindings']['parentSha256']==bindings['sample.json.fixtures.json'] and initial['bindings']['childSha256']==bindings['sample.json']
rows=[]
for name in ['initial-phases.json','baseline-patch.json','sampling-patch.json']:
 d=initial if name=='initial-phases.json' else read(name)
 assert d['gate']=='PASS' and d['sourceCommit']==child['sourceCommit'] and d['prefix']==child['prefix']
 for row in d['records']:
  p={v['phase']:v for v in row['phases']}
  if 'runtime-initialize' not in p:continue
  assert len(p)==len(row['phases'])
  report=row['platformReports'];assert len(report)==1 and report[0]['initDurationMs']>0 and report[0]['memoryMiB']==512
  invocation=row.get('lambdaRequestId') or row['lambda'][0]['lambdaRequestId'];assert report[0]['lambdaRequestId']==invocation
  for phase in p.values():assert phase['gatewayRequestId']==row['requestId'] and phase['lambdaRequestId']==invocation
  def inside(a,b):assert ms(p[a]['startedAt'])>=ms(p[b]['startedAt'])-2 and ms(p[a]['completedAt'])<=ms(p[b]['completedAt'])+2
  for n in ['runtime-database-secret','runtime-license-secret']:inside(n,'runtime-initialize')
  for n in ['db-engine-prepare','admin-account-query']:inside(n,'admin-account-hook')
  inside('db-engine-after-adapter','db-engine-prepare');inside('db-adapter-connect','db-engine-prepare')
  for n in ['db-client-prepare','db-first-query']:inside(n,'admin-account-query')
  inside('db-first-connection','db-first-query')
  assert ms(p['db-engine-prepare']['completedAt'])<=ms(p['admin-account-query']['startedAt'])+2
  for n in ['runtime-initialize','runtime-database-secret','runtime-license-secret','db-engine-prepare','db-engine-after-adapter','admin-account-query']:
   assert p[n]['outcome']=='PASS' and p[n]['errorCode']=='NONE'
  for n in ['db-engine-prepare','db-engine-after-adapter','admin-account-query']:
   v=p[n];assert v['processCpuScope']=='PROCESS_ALL_THREADS' and all(type(v[k])==int and v[k]>=0 for k in ['processCpuUserUs','processCpuSystemUs'])
  assert p['db-engine-prepare']['completionBoundary']==p['db-engine-after-adapter']['completionBoundary']=='OPERATION_SETTLED' and p['db-client-prepare']['completionBoundary']=='DRIVER_DISPATCH'
  a,b=p['runtime-database-secret'],p['runtime-license-secret'];overlap=max(0,min(ms(a['completedAt']),ms(b['completedAt']))-max(ms(a['startedAt']),ms(b['startedAt'])))
  assert overlap>0
  rows.append({'receipt':name,'requestId':row['requestId'],'lambdaRequestId':invocation,'status':int(row['gateway'][0]['status']),'gatewayMs':float(row['gateway'][0]['responseLatency']),'lambdaMs':(row.get('completion') or row['lambda'])[0]['elapsedMs'],'platformReport':report[0],'secretOverlapMs':round(overlap),'phases':{n:{k:v[k] for k in ['durationMs','processCpuUserUs','processCpuSystemUs','completionBoundary'] if k in v} for n,v in p.items()}})
assert len(rows)>=3
for a,b in [('api-config-predeploy.json','api-config-final.json'),('api-concurrency-initial.json','api-concurrency-final.json')]:assert read(a)==read(b)
(r/'initialization-analysis.json').write_text(json.dumps({'gate':'PASS','sourceCommit':child['sourceCommit'],'prefix':child['prefix'],'scope':'EXACT_PHYSICAL_COLD_INITIALIZATION_SECRET_OVERLAP_ENGINE_AND_MODEL_CPU','p95Accepted':False,'rows':rows,'boundaries':'Nested intervals must not be added. Process CPU includes all threads. Account query includes driver handling, not pure compiler CPU. No causal before/after attribution or network-node diagnosis.','bindings':bindings},indent=2)+'\n')
print(json.dumps({'gate':'PASS','physicalColdRows':len(rows),'secretOverlapMs':[v['secretOverlapMs'] for v in rows]}))
