"""Verify this sealed inventory and bound candidate bytes without AWS access."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;repo=root.parents[3];h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((root/'manifest.json').read_bytes())
assert {str(p.relative_to(root)):h(p) for p in root.rglob('*') if p.is_file() and p.name!='manifest.json'}==m['files'],'EVIDENCE_DRIFT'
for n,digest in m['bindings'].items():assert h(repo/n)==digest,'BOUND_SOURCE_OR_DOCUMENT_DRIFT:'+n
print(json.dumps({'gate':'PASS','scope':'SEALED_INVENTORY_AND_CANDIDATE_BYTES_ONLY','files':len(m['files']),'bindings':len(m['bindings']),'recordedGate':m['recordedGate'],'fullQa09Accepted':False,'p95Accepted':False}))
