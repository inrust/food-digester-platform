"""Seal only this new root after both owned units and actual default-off recovery."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;sha='b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e'
for mode,name in [('r0','unit-completion.json'),('r1','unit-completion.json'),('restore','restore-completion.json')]:
 p=root/mode;v=json.loads((p/name).read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
 for n,h in v['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,'UNIT_BYTES_DRIFT'
v=json.loads((root/'comparison.json').read_text());assert v['gate']=='PARTIAL' and v['restoreGate']=='PASS'
for n,h in v['bindings'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==h,'COMPARISON_BYTES_DRIFT'
assert json.loads((root/'final-checks/summary.json').read_text())['gate']=='PASS'
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
result={'gate':'PARTIAL','scope':'NEW_R0_R1_BOUND_BUSINESS_PHASE_OWN_CLEANUP_AND_DEFAULT_OFF_RESTORE','sourceCommit':sha,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'r0Gate':'PASS','r1Gate':'PASS','restoreGate':'PASS','cleanupGate':'PASS','matchedNaturalColdGate':v['matchedNaturalColdGate'],'causalBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'fileCount':len(files),'files':files}
assert not (root/'manifest.json').exists();(root/'manifest.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='files'}))
