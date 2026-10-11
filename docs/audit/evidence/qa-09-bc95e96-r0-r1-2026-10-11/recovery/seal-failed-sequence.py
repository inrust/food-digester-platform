"""Seal failed sequence plus verified cleanup/restore, never a successful R0/R1 pair."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,subprocess
root=Path(__file__).resolve().parent.parent;repo=root.parents[3];sha='bc95e9671a0bfb69effa95ad7c315b375199f132';assert not (root/'manifest.json').exists()
def read(n):return json.loads((root/n).read_text())
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
names=['r0/connection-budget-gate.json','preflight/entry-completion.json','r0/cleanup-only-completion.json','r0/cleanup-recovery-completion.json','r0/artifact-transition.json','restore/restore-completion.json','restore/audit-empty-prestart-gate.json','restore/artifact-transition.json','restore/owned-domain-readonly.json','restore/owned-build-terminal-bounded.json','final-live-readonly.json','document-check.json','final-checks/failure-summary.json']
for n in names:assert read(n)['gate']=='PASS',n
assert read('restore/post-restoration-readonly.json')['gate']=='PARTIAL' and read('restore/post-restoration-readonly.json')['finalCapacityGate']=='UNKNOWN'
assert read('r0/sample.json')['gate']==read('r0/sample.json.fixtures.json')['gate']==read('r0/sample.json.gate.json')['gate']=='FAIL'
assert read('r0/cleanup-only-completion.json')['unknownBusinessAuditStart']=='UNKNOWN'
assert read('recovery/r0-existing-observations.json')['gate']=='PARTIAL' and not (root/'r1/dispatch.exit').exists()
assert read('restore/restore-completion.json')['contractObserverCost'] is False
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo).decode().strip()==sha
assert not subprocess.check_output(['git','diff',sha,'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],cwd=repo)
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
completion=dict(gate='PARTIAL',scope='REQUESTED_SEQUENCE_STOPPED_ON_ORIGINAL_R0_FAILURE_WITH_RESIDUAL_ABSENCE_AND_DEFAULT_OFF_RESTORE',sourceCommit=sha,originalR0Gate='FAIL',originalChildCleanupGate='FAIL',originalParentAggregateGate='FAIL',r1Gate='NOT_RUN',residualCleanupGate='PASS',restoreGate='PASS',restorePostReadOnlyGate='PARTIAL',finalCapacityStart='UNKNOWN',unknownReadOnlyBusinessAuditStart='UNKNOWN',originalGlobalSignOutGate='FAIL',actualCandidateSwitchesFalse=5,ownedArchivePrefixesEmpty=2,businessReplays=0,extraBusinessRequests=0,matchedNaturalColdGate='NOT_RUN',causalBenefit='NOT_ESTABLISHED',qa09Gate='PARTIAL',p95Accepted=False,fullQa09Accepted=False,bindings={n:digest(root/n) for n in names+['recovery/r0-existing-observations.json','recovery/unknown-audit-binding-diagnostic.json','recovery/unknown-start-cloudtrail.json','recovery/unknown-start-cloudtrail-final.json','restore/post-restoration-readonly.json','restore/unknown-starts-final-status.json','restore/capacity-before.json','recovery/unknown-restored-capacity-diagnostic.json','recovery/unknown-restored-capacity-cloudtrail.json']},finishedAt=datetime.now(timezone.utc).isoformat())
(root/'completion.json').write_text(json.dumps(completion,indent=2)+'\n')
documents=read('document-check.json')['documentBindings']
for n,h in documents.items():assert digest(repo/n)==h,n
files={str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file()}
manifest=dict(gate='PARTIAL',seal='PASS',scope=completion['scope'],sourceCommit=sha,originalR0Gate='FAIL',r1Gate='NOT_RUN',residualCleanupGate='PASS',restoreGate='PASS',restorePostReadOnlyGate='PARTIAL',finalCapacityStart='UNKNOWN',unknownReadOnlyStart='UNKNOWN',p95Accepted=False,fullQa09Accepted=False,fileCount=len(files),files=files,documentBindings=documents,notes=['Original failed CI, blocked artifact read, failed unit, unknown StartBuild and GlobalSignOut failure are preserved.','Independent audit-empty was the planned final readonly residual audit, not the unknown business-audit Plan.','No R1 dispatch, business replay, new negative requests, forced cold, extra sampling, IAM/KMS or capacity changes.','Prospective full-pair helpers remain unexecuted; only recovery/final-failure-checks.py validates this outcome.'],sealedAt=datetime.now(timezone.utc).isoformat())
(root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
for n,h in files.items():assert digest(root/n)==h,n
print(json.dumps(dict(gate='PASS',sequenceGate='FAIL',qa09Gate='PARTIAL',files=len(files))))
