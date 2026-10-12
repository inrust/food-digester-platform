"""Historical inventory/committed bindings plus the current pushed offline parent repair."""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parent;repo=root.parents[3];sha='ad213fa27375369fc0320f1747b1490a6292a41b';h=lambda b:hashlib.sha256(b).hexdigest();files=0;bindings=0
items=[('qa-09-log-read-budget-2026-10-12','ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'),('qa-09-ebbcfc0-r0-r1-2026-10-12','f7f996f278877cb57fc9d400f8f1d24b6ff5ff48'),('qa-09-auxiliary-batches-2026-10-12','f7f996f278877cb57fc9d400f8f1d24b6ff5ff48'),('qa-09-f7f996f-r0-r1-2026-10-12','be97cb60d356c6b86eea85455e2087ff54d0bb5a'),('qa-09-auxiliary-epoch-2026-10-12','be97cb60d356c6b86eea85455e2087ff54d0bb5a'),('qa-09-be97cb6-r0-r1-2026-10-12','ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2'),('qa-09-window-parent-repair-2026-10-12','ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2'),('qa-09-ac5c0c3-r0-r1-2026-10-12','f082cce34439a2fc8fb1a21f07072a6106ff3495'),('qa-09-unknown-start-batches-2026-10-12',sha)]
for name,commit in items:
 old=repo/'docs/audit/evidence'/name;m=json.loads((old/'manifest.json').read_bytes())
 assert {str(p.relative_to(old)):h(p.read_bytes()) for p in old.rglob('*') if p.is_file() and p.name!='manifest.json'}==m['files'],'HISTORICAL_FILE_DRIFT:'+name
 for n,wanted in m['bindings'].items():
  assert h(subprocess.check_output(['git','show',commit+':'+n],cwd=repo))==wanted,n
  if name in ['qa-09-auxiliary-epoch-2026-10-12','qa-09-window-parent-repair-2026-10-12','qa-09-unknown-start-batches-2026-10-12'] and (n.startswith('scripts/') or n.startswith('packages/')):assert h((repo/n).read_bytes())==wanted,'QA_RUNTIME_SOURCE_DRIFT:'+n
 files+=len(m['files']);bindings+=len(m['bindings'])
assert files==1683 and bindings==96
print(json.dumps({'gate':'LOCAL_UNKNOWN_START_BATCH_PASS','scope':'HISTORICAL_INVENTORIES_COMMITTED_BINDINGS_AND_PUSHED_UNKNOWN_START_READ_BYTES_ONLY','sourceCommit':sha,'sealedFiles':files,'sourceBindings':bindings,'newTargetAcceptance':False,'fullQa09Accepted':False}))
