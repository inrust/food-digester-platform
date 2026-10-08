"""Bound elapsed observations only; no causal/compiler/transport-node attribution."""
import json,hashlib,sys
from pathlib import Path
root=Path(__file__).parent;bindings={};out={}
assert sys.argv[1:] in [[],['--r0-only']]
for mode in (['r0'] if sys.argv[1:] else ['r0','r1']):
 seen=set();rows=[]
 for name in ['baseline-patch.json','sampling-patch.json','baseline-audit.json','sampling-audit.json']:
  p=root/mode/name;b=p.read_bytes();v=json.loads(b);assert v['gate']=='PASS';bindings[mode+'/'+name]=hashlib.sha256(b).hexdigest()
  for c in v['records']:
   lam=c.get('lambda',c.get('completion'));assert len(lam)==1 and len(c['gateway'])==1 and len(c['platformReports'])==1
   inv=lam[0]['lambdaRequestId'];assert inv==c['gateway'][0]['integrationRequestId']==c['platformReports'][0]['lambdaRequestId']
   if inv in seen:continue
   seen.add(inv);phases={p['phase']:p for p in c['phases']};get=lambda n:phases.get(n,{}).get('durationMs')
   rows.append({'requestId':c['requestId'],'lambdaRequestId':inv,'origin':name,'status':c['status'],'physicalCold':c['platformReports'][0].get('initDurationMs',0)>0,'initDurationMs':c['platformReports'][0].get('initDurationMs'),'applicationMs':lam[0]['elapsedMs'],'gatewayMs':float(c['gateway'][0]['responseLatency']),'clientMs':c.get('latencyMs'),'clientTransport':c.get('clientTransport'),'phasesMs':{n:get(n) for n in ['db-authenticated-preconnect','db-engine-prepare','db-client-prepare','db-client-observer-setup','db-client-submit','db-client-await-dispatch','admin-account-query','admin-account-hook','db-first-query','db-first-connection','db-transaction','contract-load','contract-version-update','audit-failure-write']},'clientPreparationProcessCpuUserUs':phases.get('db-client-prepare',{}).get('processCpuUserUs'),'clientPreparationProcessCpuSystemUs':phases.get('db-client-prepare',{}).get('processCpuSystemUs')})
 out[mode]={'exactRequests':len(rows),'physicalCold409':[r for r in rows if r['status']==409 and r['physicalCold']],'transportAtLeast1s':[r for r in rows if any((r.get('clientTransport') or {}).get(k,0) is not None and (r.get('clientTransport') or {}).get(k,0)>=1000 for k in ['tcpMs','tlsMs'])],'rows':rows}
result={'gate':'OBSERVATIONS_ONLY','sourceCommit':'88d9f0a5a734aacf0aef6af69c5a4985baacfe84','scope':'EXACT_BOUND_REQUEST_ELAPSED_NOT_CAUSAL_OR_P95','processCpuScope':'PROCESS_ALL_THREADS','firstPublicQueryNotEquivalentToFirstModelQuery':True,'compilerOnlyAttribution':False,'networkNodeAttribution':'UNRESOLVED','p95Accepted':False,'units':out,'bindings':bindings}
output=root/('stage-observations-r0-only.json' if sys.argv[1:] else 'stage-observations.json');assert not output.exists()
output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({m:{'exactRequests':v['exactRequests'],'physicalCold409':len(v['physicalCold409']),'transportAtLeast1s':len(v['transportAtLeast1s'])} for m,v in out.items()}))
