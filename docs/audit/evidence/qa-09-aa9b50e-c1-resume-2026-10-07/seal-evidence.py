"""Seal immutable same-SHA reused C0, new C1 and actual default-off restoration."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;sha='aa9b50eb010e2a1735084be587613431e6664ed3'
for mode,name in [('c0','unit-completion.json'),('c1','unit-completion.json'),('restore','restore-gate.json')]:
 p=root/mode;v=json.loads((p/name).read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
 for f,h in v['bindings'].items():assert hashlib.sha256((p/f).read_bytes()).hexdigest()==h,'CLOSURE_BYTE_DRIFT'
for name in ['deployed-pair-gate.json','preflight/entry-gate.json']:
 v=json.loads((root/name).read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
 for f,h in v['bindings'].items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==h
comparison=json.loads((root/'comparison.json').read_text());assert comparison['gate']=='PARTIAL' and comparison['sourceCommit']==sha
for key in ['inputPairGate','targetVersionPairGate','businessPairGate','cleanupPairGate']:assert comparison[key]=='PASS'
for f,h in comparison['bindings'].items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==h
assert json.loads((root/'c1/initial-topology-gate.json').read_text())['observed']>0
assert json.loads((root/'final-checks/summary.json').read_text())['gate']=='PASS'
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
v={'gate':'PARTIAL','scope':'REUSED_IMMUTABLE_SAME_SHA_C0_NEW_C1_CLOSED_AND_FALSE_RESTORED','sourceCommit':sha,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'c0Gate':'PASS','c1Gate':'PASS','restoreGate':'PASS','cleanupGate':'PASS','candidateTargetBenefit':'NOT_ESTABLISHED','fullQa09Accepted':False,'p95Accepted':False,'fileCount':len(files),'files':files}
assert not (root/'manifest.json').exists();(root/'manifest.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({k:v for k,v in v.items() if k!='files'}))
