"""Seal this failed original R0 and successful exact cleanup/default restoration only."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;sha='f7abb0670398a1254fcf45755f077b41f4fcd4c0'
for mode,n in [('r0','cleanup-only-completion.json'),('restore','restore-completion.json'),('restore','post-restoration-readonly.json')]:
 v=json.loads((root/mode/n).read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
 for k,h in v['bindings'].items():assert hashlib.sha256((root/mode/k).read_bytes()).hexdigest()==h
assert json.loads((root/'r0/sample.json.gate.json').read_text())['gate']=='FAIL'
assert not (root/'r1/dispatch.exit').exists()
assert json.loads((root/'final-checks/summary.json').read_text())['gate']=='PASS'
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
v={'gate':'PARTIAL','scope':'FAILED_ORIGINAL_R0_WITH_ORIGINAL_OWN_CLEANUP_AND_DEFAULT_OFF_RESTORED','sourceCommit':sha,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'r0Gate':'FAIL','r0Failure':'EXECUTED_SOURCE_DRIFT','r1Gate':'NOT_RUN','cleanupGate':'PASS','restoreGate':'PASS','matchedNaturalColdGate':'NOT_RUN','causalBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'fileCount':len(files),'files':files};assert not (root/'manifest.json').exists();(root/'manifest.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({k:x for k,x in v.items() if k!='files'}))
