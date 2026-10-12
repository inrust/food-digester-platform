"""Validate immutable predecessor files against committed bindings, and current QA sources."""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parent;repo=root.parents[3];sha='f7f996f278877cb57fc9d400f8f1d24b6ff5ff48'
h=lambda b:hashlib.sha256(b).hexdigest()
files=0;bindings=0
for name,commit in [('qa-09-log-read-budget-2026-10-12','ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'),('qa-09-ebbcfc0-r0-r1-2026-10-12',sha),('qa-09-auxiliary-batches-2026-10-12',sha)]:
 old=repo/'docs/audit/evidence'/name;m=json.loads((old/'manifest.json').read_bytes())
 actual={str(p.relative_to(old)):h(p.read_bytes()) for p in sorted(old.rglob('*')) if p.is_file() and p.name!='manifest.json'}
 assert actual==m['files'],'HISTORICAL_FILE_DRIFT:'+name
 for n,wanted in m['bindings'].items():
  assert h(subprocess.check_output(['git','show',commit+':'+n],cwd=repo))==wanted,n
  if n.startswith('scripts/'):assert h((repo/n).read_bytes())==wanted,'QA_RUNTIME_SOURCE_DRIFT:'+n
 files+=len(actual);bindings+=len(m['bindings'])
assert files==702
print(json.dumps({'gate':'LOCAL_AUXILIARY_BATCH_CANDIDATE_PASS','scope':'HISTORICAL_INVENTORIES_COMMITTED_DOCUMENT_BINDINGS_AND_CURRENT_QA_SOURCE_ONLY','sourceCommit':sha,'sealedFiles':files,'sourceBindings':bindings,'newTargetAcceptance':False,'fullQa09Accepted':False}))
