"""Check historical bytes against their application SHA, never current modified collector bytes."""
import hashlib
import json
import subprocess
from pathlib import Path
root = Path(__file__).resolve().parent
sha = '41ee358fb92e4dae2ae4abba7eb9923996fe029b'
hash_bytes = lambda data: hashlib.sha256(data).hexdigest()
old = Path('docs/audit/evidence/qa-09-owned-summary-2026-10-11')
m = json.loads((old/'manifest.json').read_text())
files = {str(p.relative_to(old)):hash_bytes(p.read_bytes()) for p in sorted(old.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
assert files == m['files'], 'HISTORICAL_IMPLEMENTATION_BYTES'
for path, expected in m['bindings'].items():
    assert hash_bytes(subprocess.check_output(['git','show',sha+':'+path])) == expected, path
inputs = json.loads((old/'sealed-runtime-matrix/matrix.json').read_text())['inputs']
for item in inputs:
    path = item['path']
    tracked = subprocess.run(['git','ls-files','--error-unmatch',path],capture_output=True).returncode == 0
    data = subprocess.check_output(['git','show',sha+':'+path]) if tracked else Path(path).read_bytes()
    assert hash_bytes(data) == item['sha256'], path
q = subprocess.run(['python3','docs/audit/evidence/qa-09-41ee358f-r0-r1-2026-10-11/check-failed-stage-seal.py','--check'],capture_output=True,text=True,check=True)
previous = json.loads(q.stdout)
assert previous['boundedSequenceGate']=='PARTIAL' and previous['r1LogReadRecoveryGate']=='FAIL'
result = {'gate':'PASS','scope':'HISTORICAL_BYTES_AT_ORIGINAL_SHA_ONLY','sourceCommit':sha,
          'implementationFiles':len(files),'sourceBindings':len(m['bindings']),'runtimeInputs':len(inputs),
          'previousTargetSeal':previous,'newTargetGate':'NOT_RUN','fullQa09Accepted':False}
output = root/'historical-evidence.json'
assert not output.exists()
output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'gate':'PASS','implementationFiles':len(files),'targetFiles':previous['sealedFiles']}))
