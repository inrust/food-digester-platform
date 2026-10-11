"""One exact read-only recovery of the 12 existing R1 invocations; no business replay."""
import hashlib,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent;p=root/'r1';out=p/'sampling-patch-recovered.json';proof=p/'log-read-recovery.json'
assert not out.exists() and not proof.exists() and not (p/'log-read-recovery.exit').exists(),'NO_RECOVERY_REPLAY'
prior=p/'sampling-patch.json';raw=prior.read_bytes();v=json.loads(raw)
assert v['gate']=='PARTIAL' and v['logReadErrors']=={'lambda':'LOG_READ_TIMEOUT'} and len(v['records'])==12
assert v['observerCostRequired'] and v['ownedBoundariesRequired'] and v['observerCostRejected']==0
assert int((p/'collect-correlations.closure.exit').read_text())!=0
for n in ['sample.json','sample.json.fixtures.json','sample.json.gate.json','database-empty-audit.json']:
 assert json.loads((p/n).read_text())['gate']=='PASS'
args=['python3','scripts/collect-qa09-contract-correlation.py',str(p/'sample.json'),str(out),'--exact-from',str(prior),'--cold-sampling','--observer-cost','--owned-boundaries']
(p/'log-read-recovery.command.json').write_text(json.dumps(args,indent=2)+'\n')
with (p/'log-read-recovery.stdout.log').open('w') as o,(p/'log-read-recovery.stderr.log').open('w') as e:q=subprocess.run(args,stdout=o,stderr=e)
(p/'log-read-recovery.exit').write_text(str(q.returncode)+'\n')
assert hashlib.sha256(prior.read_bytes()).hexdigest()==hashlib.sha256(raw).hexdigest(),'ORIGINAL_CHANGED'
assert q.returncode==0
w=json.loads(out.read_text());assert w['gate']=='PASS' and w['exactLinkedCount']==12 and w['logReadErrors']=={}
assert w['observerCostRequired'] and w['ownedBoundariesRequired'] and w['observerCostRejected']==0
assert w['sourceReceiptSha256']==v['sourceReceiptSha256'] and w['readOptimization']['priorGatewayReceiptSha256']==hashlib.sha256(raw).hexdigest()
assert [r['requestId'] for r in w['records']]==[r['requestId'] for r in v['records']]
names=['sampling-patch.json','sampling-patch-recovered.json','collect-correlations.closure.exit','collect-correlations.closure.stderr.log','log-read-recovery.command.json','log-read-recovery.exit','sample.json','sample.json.fixtures.json','sample.json.gate.json','database-empty-audit.json']
r={'gate':'PASS','scope':'ONE_EXACT_EXISTING_LOG_READ_RECOVERY_ONLY','sourceCommit':v['sourceCommit'],'prefix':v['prefix'],'originalGate':'PARTIAL','originalClosureExit':1,'originalError':'LOG_READ_TIMEOUT','recoveryGate':'PASS','requests':12,'newBusinessRequests':0,'newFixtures':0,'extraSamples':0,'originalReceiptsUnchanged':True,'bindings':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in names},'fullQa09Accepted':False,'p95Accepted':False}
proof.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k!='bindings'}),flush=True)
