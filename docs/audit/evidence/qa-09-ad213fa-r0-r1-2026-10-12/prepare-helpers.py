"""Fresh helpers with exact historical origins; no target receipt is copied."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;repo=root.parents[3];old=repo/'docs/audit/evidence/qa-09-ac5c0c3-r0-r1-2026-10-12';sha='ad213fa27375369fc0320f1747b1490a6292a41b'
for mode in ['preflight','default-off','r0','r1','restore']:(root/mode).mkdir(exist_ok=True)
keys=json.loads((old/'preflight/entry-scope.json').read_bytes())['entryHelpers'];rows=[]
for name in keys:
 if name in ['prepare-helpers.py','check-implementation-seal.py']:continue
 p=root/name;p.parent.mkdir(exist_ok=True);assert not p.exists(),name;origin=old/name
 s=origin.read_text().replace(str(old.relative_to(repo)),str(root.relative_to(repo))).replace('ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2',sha).replace('38202951354','38219979523').replace('38202951361','38219979629').replace('LOCAL_PUBLIC_WINDOW_PARENT_PASS','LOCAL_UNKNOWN_START_BATCH_PASS').replace("get('sealedFiles',1210)","get('sealedFiles',1683)")
 if name=='check-helper-inputs.py':
  s=s.replace("paths=['scripts/collect-qa09-contract-correlation.py'", "paths=['scripts/qa09-unknown-start-read.mjs','scripts/read-qa09-unknown-start.mjs','scripts/qa09-unknown-start-read.test.mjs','scripts/collect-qa09-contract-correlation.py'")
 if name in ['check-observer-artifact-transition.py','validate-current-pair.py']:
  s=s.replace('application-version-after-ci.json','application-version.json')
 if name=='validate-current-pair.py':
  begin=s.index('implementation_count = ');end=s.index("for mode in ['r0', 'r1']:",begin)
  s=s[:begin]+"implementation_count = 36\nhist_count = json.loads(q.stdout)['sealedFiles']\n"+s[end:]
 p.write_text(s);rows.append({'path':name,'origin':str(origin.relative_to(repo)),'originSha256':hashlib.sha256(origin.read_bytes()).hexdigest(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(root/'preflight/helper-origins.json').write_text(json.dumps({'sourceCommit':sha,'helpers':rows,'newTargetReceiptsCopied':0},indent=2)+'\n');print('fresh helpers',len(rows))
