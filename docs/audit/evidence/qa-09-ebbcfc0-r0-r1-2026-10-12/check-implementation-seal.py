"""Validate pushed implementation evidence and code, preserve user-owned AGENTS edit."""
import hashlib,json,subprocess
from pathlib import Path
sha='ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'
old=Path('docs/audit/evidence/qa-09-log-read-budget-2026-10-12')
h=lambda b:hashlib.sha256(b).hexdigest()
m=json.loads((old/'manifest.json').read_text())
assert {str(p.relative_to(old)):h(p.read_bytes()) for p in sorted(old.rglob('*')) if p.is_file() and p.name!='manifest.json'}==m['files']
userEdits=[]
for name,expected in m['bindings'].items():
 assert h(subprocess.check_output(['git','show',sha+':'+name]))==expected,name
 actual=h(Path(name).read_bytes())
 if actual!=expected:
  assert name=='AGENTS.md','EXECUTABLE_SOURCE_DRIFT:'+name
  userEdits.append({'path':name,'committedSha256':expected,'worktreeSha256':actual,'preserved':True,'runtimeDependency':False})
assert m['gate']=='LOCAL_LOG_READ_BUDGET_PASS' and m['focusedTests']==103 and m['finalScriptTests']==1129 and m['localVerifyCommands']==22
print(json.dumps({'gate':m['gate'],'scope':'PUSHED_SHA_IMPLEMENTATION_AND_SEALED_LOCAL_EVIDENCE','sourceCommit':sha,'sealedFiles':len(m['files']),'sourceBindings':len(m['bindings']),'userOwnedEdits':userEdits,'fullQa09Accepted':False}))
