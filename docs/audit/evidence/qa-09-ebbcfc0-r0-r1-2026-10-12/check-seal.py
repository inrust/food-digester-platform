"""Validate this evidence inventory and bound source bytes, without cloud access."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;repo=root.parents[3]
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((root/'manifest.json').read_bytes())
actual={str(p.relative_to(root)):h(p) for p in sorted(root.rglob('*')) if p.is_file() and p.name!='manifest.json'}
assert actual==m['files'],'EVIDENCE_INVENTORY_OR_BYTES_DRIFT'
for n,wanted in m['bindings'].items():assert h(repo/n)==wanted,'SOURCE_OR_DOCUMENT_DRIFT:'+n
print(json.dumps({'gate':'PASS','scope':'EVIDENCE_INVENTORY_AND_BOUND_BYTES_ONLY','files':len(actual),'bindings':len(m['bindings']),'targetGate':m['targetGate'],'fullQa09Accepted':False,'p95Accepted':False}))
