"""Fresh helpers only, with committed origins; never copy target receipts."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;repo=root.parents[3];old=repo/'docs/audit/evidence/qa-09-be97cb6-r0-r1-2026-10-12';sha='ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2'
for mode in ['preflight','default-off','r0','r1','restore']:(root/mode).mkdir(exist_ok=True)
keys=json.loads((old/'preflight/entry-scope.json').read_bytes())['entryHelpers'];rows=[]
for name in keys:
 if name in ['prepare-helpers.py','check-implementation-seal.py']:continue
 p=root/name;p.parent.mkdir(exist_ok=True);assert not p.exists(),name;origin=old/name
 s=origin.read_text().replace(str(old.relative_to(repo)),str(root.relative_to(repo))).replace('be97cb60d356c6b86eea85455e2087ff54d0bb5a',sha).replace('38198491221','38202951354').replace('38198491245','38202951361').replace('LOCAL_GATEWAY_EPOCH_COMPATIBILITY_PASS','LOCAL_PUBLIC_WINDOW_PARENT_PASS').replace("get('sealedFiles',937)","get('sealedFiles',1210)")
 p.write_text(s);rows.append({'path':name,'origin':str(origin.relative_to(repo)),'originSha256':hashlib.sha256(origin.read_bytes()).hexdigest(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(root/'preflight/helper-origins.json').write_text(json.dumps({'sourceCommit':sha,'helpers':rows,'newTargetReceiptsCopied':0},indent=2)+'\n');print('fresh helpers',len(rows))
