import json,sys
from pathlib import Path
root=Path(sys.argv[1]);suffix=sys.argv[2] if len(sys.argv)>2 else '';out={'scope':'OWN_REQUEST_PHASE_LATENCY_DIAGNOSTICS_NOT_P95_ACCEPTANCE','fullQa09Accepted':False,'p95Accepted':False,'records':[]}
for filename in ['request-correlation'+suffix+'.json','audit-get-correlation'+suffix+'.json']:
 r=json.loads((root/filename).read_text())
 for c in r['records']:
  if not c.get('exactLinked') or len(c.get('lambda',[]))!=1 or len(c.get('gateway',[]))!=1:continue
  l=c['lambda'][0];g=c['gateway'][0];phases=c.get('phases',[])
  top=['runtime-initialize','admin-authenticate','db-transaction','audit-failure-write','audit-list-query','audit-detail-query','audit-view','response-serialize']
  measured=sum(p['durationMs'] for p in phases if p.get('phase') in top)
  out['records'].append({'id':c['id'],'requestId':c['requestId'],'method':c['method'],'status':c.get('status'),'responseReceived':c['responseReceived'],'clientMs':c['latencyMs'],'gatewayMs':int(g['responseLatency']),'lambdaMs':l['elapsedMs'],'gatewayArrivalAfterClientStartMs':int(g['requestTimeEpoch'])-c['startMs'],'topLevelMeasuredMs':measured,'unmeasuredLambdaResidualMs':l['elapsedMs']-measured,'phaseDurations':{p['phase']:p['durationMs'] for p in phases},'residualBoundary':'Not pure pool wait; includes uninstrumented account-status hook, routing and instrumentation overhead. Nested transaction phases excluded from top-level sum.'})
(root/('phase-latency-analysis'+suffix+'.json')).write_text(json.dumps(out,indent=2)+'\n')
for method in ['PATCH','GET']:
 rows=[r for r in out['records'] if r['method']==method]
 print(method,len(rows),'clientMax',max((r['clientMs'] for r in rows),default=0),'lambdaMax',max((r['lambdaMs'] for r in rows),default=0))
print(json.dumps(sorted(out['records'],key=lambda r:r['lambdaMs'],reverse=True)[:4],indent=2))
