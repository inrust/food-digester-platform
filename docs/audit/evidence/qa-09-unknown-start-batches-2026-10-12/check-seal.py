from pathlib import Path
import hashlib,json,subprocess
r=Path(__file__).resolve().parent;repo=r.parents[3];h=lambda b:hashlib.sha256(b).hexdigest()
old=repo/'docs/audit/evidence/qa-09-ac5c0c3-r0-r1-2026-10-12';m=json.loads((old/'manifest.json').read_bytes())
assert {str(p.relative_to(old)):h(p.read_bytes()) for p in old.rglob('*') if p.is_file() and p.name!='manifest.json'}==m['files']
assert len(m['files'])==437 and len(m['bindings'])==19
for path,wanted in m['bindings'].items():assert h(subprocess.check_output(['git','show','f082cce34439a2fc8fb1a21f07072a6106ff3495:'+path],cwd=repo))==wanted
receipt=json.loads((old/'r0/sample.json.business-audit-2.json').read_bytes())
assert receipt['gate']=='FAIL' and receipt['failure']['kind']=='START_OUTCOME_UNCONFIRMED' and not receipt.get('build')
current=json.loads((r/'manifest.json').read_bytes())
assert {str(p.relative_to(r)):h(p.read_bytes()) for p in r.rglob('*') if p.is_file() and p.name!='manifest.json'}==current['files']
for path,wanted in current['bindings'].items():assert h((repo/path).read_bytes())==wanted,path
print(json.dumps({'gate':'LOCAL_UNKNOWN_START_BATCH_PASS','scope':'LOCAL_MATRIX_IMMUTABILITY_AND_SOURCE_BYTES_ONLY','historicalFiles':437,'historicalBindings':19,'sealedFiles':len(current['files']),'sourceBindings':len(current['bindings']),'originalFailureRetained':True,'restartAllowed':False,'targetAcceptance':False}))
