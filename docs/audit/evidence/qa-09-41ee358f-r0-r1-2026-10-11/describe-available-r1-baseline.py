"""Describe available original R1 baseline only; preserve failed sampling gate, no cloud reads."""
import json,hashlib,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent;p=root/'r1';out=p/'available-baseline-description.json';assert not out.exists()
closure=json.loads((p/'cleanup-only-completion.json').read_text());assert closure['gate']=='PASS' and closure['stageGate']=='FAIL'
args=['node','scripts/check-qa09-contract-phases.mjs',str(p/'sample.json'),str(p/'baseline-patch.json'),str(p/'baseline-audit.json'),str(p/'available-baseline-phases.json'),'--account-phases','--client-preparation','--client-split','--contract-load-split','--contract-load-detail','--contract-await-checkpoint','--contract-public-boundaries','--runtime-assembly','--observer-cost','--owned-boundaries','--engine-cpu','--authenticated-preconnect']
(p/'available-baseline.command.json').write_text(json.dumps(args,indent=2)+'\n')
q=subprocess.run(args,capture_output=True,text=True);(p/'available-baseline.stdout.log').write_text(q.stdout);(p/'available-baseline.stderr.log').write_text(q.stderr);(p/'available-baseline.exit').write_text(str(q.returncode)+'\n');assert q.returncode==0
names=['baseline-patch.json','baseline-audit.json','sampling-audit.json'];receipts={n:json.loads((p/n).read_text()) for n in names};rows=[];summaries=[]
for n,v in receipts.items():
 assert v['gate']=='PASS'
 for x in v['records']:
  assert x['exactLinked'] and len(x['lambda'])==1
  t=x['clientTransport'];rows.append({'group':n,'id':x['id'],'requestId':x['requestId'],'status':x['status'],'clientMs':x['latencyMs'],'lambdaMs':x['lambda'][0]['elapsedMs'],'physicalCold':any(y.get('initDurationMs',0)>0 for y in x['platformReports']),'transport':t})
  if n=='baseline-patch.json':
   z=x['contractObserverCost'];assert len(z)==1 and z[0]['schemaVersion']==2 and z[0]['status']=='COMPLETE'
   summaries.append({'id':x['id'],'requestId':x['requestId'],'physicalCold':any(y.get('initDurationMs',0)>0 for y in x['platformReports']),'clientMs':x['latencyMs'],'phaseMs':{y['phase']:y['durationMs'] for y in x['phases'] if y['phase'].startswith('contract-load')},'summary':z[0]})
long=[x for x in rows if any((x['transport'].get(k) or 0)>=1000 for k in ['tcpMs','tlsMs'])]
assert len(rows)==43 and len(summaries)==6
v={'gate':'DESCRIPTIVE_ONLY','scope':'AVAILABLE_ORIGINAL_R1_BASELINE_6_PATCH_19_AUDIT_AND_SAMPLING_18_AUDIT_ONLY','sourceCommit':closure['sourceCommit'],'prefix':closure['prefix'],'baselinePhaseGate':'PASS','fullR1StageGate':'FAIL','missingSamplingPatchInvocations':12,'summaries':summaries,'requestCount':43,'transportRows':rows,'longTailRequestCount':len(long),'warmLongTailRequestCount':sum(not x['physicalCold'] for x in long),'maxTcpMs':max((x['transport'].get('tcpMs') or 0) for x in rows),'maxTlsMs':max((x['transport'].get('tlsMs') or 0) for x in rows),'newRequests':0,'networkNodeAttribution':'UNRESOLVED','causalBenefit':'NOT_ESTABLISHED','compilerOnlyAttribution':False,'p95Accepted':False,'fullQa09Accepted':False,'bindings':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in names+['available-baseline-phases.json','cleanup-only-completion.json']}}
out.write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({k:x for k,x in v.items() if k not in ['summaries','transportRows','bindings']}))
