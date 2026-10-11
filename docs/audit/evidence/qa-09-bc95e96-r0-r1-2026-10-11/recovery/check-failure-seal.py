"""Read-only seal check retaining failed R0 and absent R1 semantics."""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parent.parent;repo=root.parents[3];v=json.loads((root/'manifest.json').read_text());assert v['gate']=='PARTIAL' and v['seal']=='PASS' and v['originalR0Gate']=='FAIL' and v['r1Gate']=='NOT_RUN' and v['restoreGate']=='PASS' and v['unknownReadOnlyStart']=='UNKNOWN' and v['finalCapacityStart']=='UNKNOWN' and v['restorePostReadOnlyGate']=='PARTIAL' and not v['p95Accepted'] and not v['fullQa09Accepted']
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
actual={str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()};assert actual==set(v['files'])|{'manifest.json'}
for n,h in v['files'].items():assert digest(root/n)==h,n
for n,h in v['documentBindings'].items():assert digest(repo/n)==h,n
c=json.loads((root/'completion.json').read_text());assert c['gate']=='PARTIAL' and c['originalR0Gate']=='FAIL' and c['r1Gate']=='NOT_RUN'
for n,h in c['bindings'].items():assert digest(root/n)==h,n
assert not subprocess.check_output(['git','diff',v['sourceCommit'],'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],cwd=repo)
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
print(json.dumps(dict(gate='PASS',sealedFiles=len(v['files']),sequenceGate='FAIL',qa09Gate='PARTIAL',originalR0Gate='FAIL',r1Gate='NOT_RUN',restoreGate='PASS')))
