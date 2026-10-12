"""Offline replay of saved real Gateway/client rows; no AWS/network or business requests."""
from pathlib import Path
import hashlib,json,runpy,subprocess,sys
from datetime import datetime
root=Path(__file__).resolve().parent;repo=root.parents[3];out=root/sys.argv[1];assert not out.exists();out.mkdir()
old=repo/'docs/audit/evidence/qa-09-41ee358f-r0-r1-2026-10-11/r0'
mode=sys.argv[2] if len(sys.argv)>2 else 'negative';assert mode in ['initial','negative']
child=old/('sample.json' if mode=='initial' else 'negative-get.json');linked=old/(mode+'-phases.json')
parent=old/'sample.json.fixtures.json' if mode=='initial' else None
source=json.loads(child.read_bytes());prior=json.loads(linked.read_bytes());rows=prior['records']
assert source['gate']==prior['gate']=='PASS' and len(rows)==(8 if mode=='initial' else 12)
assert all(isinstance(r['gateway'][0]['requestTimeEpoch'],str) for r in rows)
if mode=='negative':assert all(r['boundary']=='COGNITO_AUTHORIZER_REJECTED_BEFORE_LAMBDA' for r in rows)
script=repo/'scripts/collect-qa09-auxiliary-phases.py';module=runpy.run_path(str(script));reader=module['log_read'];clock=[0.0];reader.time.monotonic=lambda:clock[0]
count=[0]
def fake(args,**kwargs):
 assert args[:3]==['aws','logs','filter-log-events'];count[0]+=1
 group=args[args.index('--log-group-name')+1];pattern=args[args.index('--filter-pattern')+1]
 members=pattern.strip('%').split('|');assert 1<=len(members)<=3
 events=[]
 if '--next-token' not in args and '/apigateway/' in group:
  events=[{'message':json.dumps(r['gateway'][0])} for r in rows if r['requestId'] in members]
 if '--next-token' not in args and '/lambda/' in group:
  for r in rows:
   if r['requestId'] in members:
    events.extend({'message':json.dumps(v)} for v in r['phases']+r['completion'])
   for report in r['platformReports']:
    if report['lambdaRequestId'] in members:
     line='REPORT RequestId: '+report['lambdaRequestId']
     for key,label,unit in [('durationMs','Duration','ms'),('initDurationMs','Init Duration','ms'),('memoryMiB','Memory Size','MB'),('maxMemoryMiB','Max Memory Used','MB')]:
      if key in report:line+='\t'+label+': '+str(report[key])+' '+unit
     events.append({'message':line})
 page={'events':events}
 if '--next-token' not in args:page['nextToken']='terminal-page'
 return subprocess.CompletedProcess(args,0,json.dumps(page),'')
reader.subprocess.run=fake
result=module['collect'](child,out/'aux.json',mode,source['sourceCommit'],parent)
v={'gate':'REPLAY_OBSERVATION_ONLY','scope':'SAVED_REAL_GATEWAY_AND_CLIENT_BYTES_REPLAY_WITH_CONTROLLED_CLI_ONLY','sourceCommit':source['sourceCommit'],'historicalBindings':{str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [child,linked]+([parent] if parent else [])},'collectorSha256':hashlib.sha256(script.read_bytes()).hexdigest(),'awsCalls':0,'businessRequests':0,'simulatedCliCalls':count[0],'mode':mode,'gatewayEpochTypes':['str'],'resultGate':result['gate'],'error':result['collectionError'],'records':len(result['records'])}
(out/'replay.json').write_text(json.dumps(v,indent=2)+'\n')
print(json.dumps(v))
