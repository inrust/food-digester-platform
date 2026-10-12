"""Copy immutable predecessor helpers into fresh evidence; adapt only new SHA and read budgets."""
import hashlib,json,ast
from pathlib import Path
root=Path(__file__).resolve().parent
old=Path('docs/audit/evidence/qa-09-41ee358f-r0-r1-2026-10-11').resolve()
sha='ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'
for mode in ['preflight','default-off','r0','r1','restore']: (root/mode).mkdir(exist_ok=True)
names=['read-default.py','bind-unit-deployment.py','collect-hosted-verify.py','collect-cdk-diff.py',
'prepare-entry.py','capacity-readonly.mjs','capacity-gate.py','check-prestart-entry.mjs','await-renewable-session.py',
'close-entry.py','dispatch-unit.py','run-unit.py','run-business.py','finish-unit.py','collect-connection-budget.py',
'check-initial-topology.mjs','complete-unit.py','compare-units.py','check-artifact-transition.py',
'check-observer-artifact-transition.py','run-restore.py','final-checks.py','verify-restored-owned-domain.mjs',
'verify-owned-build-terminal-bounded.py','validate-current-pair.py','describe-contract-windows.py','summarize-transport.py']
for mode in ['r0','r1']:
 names += [str(p.relative_to(old)) for p in sorted((old/mode).iterdir()) if p.suffix in ['.py','.mjs']]
names+=['restore/audit-empty.mjs','preflight/renew-normal-profile-role.py']
origins=[]
for name in names:
 target=root/name;assert not target.exists(),name
 origin=old/name
 s=origin.read_text().replace(str(old.relative_to(Path.cwd())),str(root.relative_to(Path.cwd())))
 s=s.replace('41ee358fb92e4dae2ae4abba7eb9923996fe029b',sha).replace('38136163697','38184960795')
 if name=='close-entry.py':
  s=s.replace("ci['attempt']==1", "ci['attempt']==2")
  s=s.replace("args=['node','scripts/check-qa09-owned-summary.mjs','docs/audit/evidence/qa-09-owned-summary-2026-10-11']", "args=['python3',str(root/'check-implementation-seal.py')]")
  s=s.replace("['gate']=='LOCAL_OWNED_SUMMARY_PASS'", "['gate']=='LOCAL_LOG_READ_BUDGET_PASS'")
 target.write_text(s)
 origins.append({'path':name,'origin':str(origin.relative_to(Path.cwd())),'originSha256':hashlib.sha256(origin.read_bytes()).hexdigest()})
(root/'preflight/helper-origins.json').write_text(json.dumps({'sourceCommit':sha,'helpers':origins,'newTargetReceiptsCopied':0},indent=2)+'\n')
print('fresh helper origins',len(origins))
