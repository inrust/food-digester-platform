"""Fresh same-SHA helpers only; copy no predecessor target receipt."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;repo=root.parents[3];old=repo/'docs/audit/evidence/qa-09-f7f996f-r0-r1-2026-10-12';sha='be97cb60d356c6b86eea85455e2087ff54d0bb5a'
for mode in ['preflight','default-off','r0','r1','restore']:(root/mode).mkdir(exist_ok=True)
keys=json.loads((old/'preflight/helper-input-check.json').read_bytes())['bindings'];rows=[]
for name in keys:
 if name in ['prepare-helpers.py','check-implementation-seal.py']:continue
 p=root/name;assert not p.exists(),name;origin=old/name
 s=origin.read_text().replace(str(old.relative_to(repo)),str(root.relative_to(repo))).replace('f7f996f278877cb57fc9d400f8f1d24b6ff5ff48',sha).replace('38195152567','38198491221').replace('38195152562','38198491245').replace('LOCAL_AUXILIARY_BATCH_CANDIDATE_PASS','LOCAL_GATEWAY_EPOCH_COMPATIBILITY_PASS').replace("get('sealedFiles',702)","get('sealedFiles',937)")
 p.write_text(s);rows.append({'path':name,'origin':str(origin.relative_to(repo)),'originSha256':hashlib.sha256(origin.read_bytes()).hexdigest(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(root/'preflight/helper-origins.json').write_text(json.dumps({'sourceCommit':sha,'helpers':rows,'newTargetReceiptsCopied':0},indent=2)+'\n');print('fresh helpers',len(rows))
