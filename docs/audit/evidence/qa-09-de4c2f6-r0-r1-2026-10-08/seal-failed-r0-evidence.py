"""Preserve failures and seal restoration; no R1 or performance acceptance."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;v=json.loads((root/'comparison.json').read_text());assert v['gate']=='PARTIAL' and v['r0StrictStageGate']=='FAIL' and v['r1Gate']=='NOT_RUN' and v['restoreGate']=='PASS'
for n,h in v['bindings'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==h
checks=json.loads((root/'final-checks/summary.json').read_text());assert checks['gate']=='PASS'
for n,h in checks['bindings'].items():assert hashlib.sha256((root/'final-checks'/n).read_bytes()).hexdigest()==h
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
out={'gate':'PARTIAL','scope':v['scope'],'sourceCommit':v['sourceCommit'],'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'r0BusinessGate':'PASS','r0StrictStageGate':'FAIL','r1Gate':'NOT_RUN','cleanupGate':'PASS','restoreGate':'PASS','candidateBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'fileCount':len(files),'files':files}
assert not (root/'manifest.json').exists();(root/'manifest.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k!='files'}))
