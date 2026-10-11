"""Seal this completed requested sequence only; no AWS calls or business replay."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,subprocess
root=Path(__file__).resolve().parent;repo=root.parents[3];sha='bc95e9671a0bfb69effa95ad7c315b375199f132'
assert not (root/'manifest.json').exists(),'ALREADY_SEALED'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(n):return json.loads((root/n).read_text())
summary=read('comparison.json')
assert summary['gate']=='PARTIAL' and summary['sourceCommit']==sha
assert summary['businessPairGate']==summary['cleanupPairGate']==summary['restoreGate']=='PASS'
assert summary['causalBenefit']=='NOT_ESTABLISHED' and summary['p95Accepted'] is False and summary['fullQa09Accepted'] is False
names=['comparison.json','r0/artifact-transition.json','r1/artifact-transition.json','restore/artifact-transition.json','preflight/entry-completion.json','r0/unit-completion.json','r1/unit-completion.json','r0/transport-observations.json','r1/transport-observations.json','restore/restore-completion.json','restore/post-restoration-readonly.json','restore/prestart-entry-gate.json','restore/owned-domain-readonly.json','restore/owned-build-terminal-bounded.json','final-live-readonly.json','final-checks/summary.json','document-check.json']
for n in names[1:]:assert read(n)['gate']=='PASS',n
for n,h in summary['bindings'].items():assert digest(root/n)==h,n
assert read('preflight/ci-run.json')['attempt']==2 and read('preflight/ci-run.json')['conclusion']=='success'
assert read('restore/restore-completion.json')['contractObserverCost'] is False
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo).decode().strip()==sha
assert not subprocess.check_output(['git','diff',sha,'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],cwd=repo)
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
documents=read('document-check.json')['documentBindings']
for n,h in documents.items():assert digest(repo/n)==h,n
completion=dict(gate='PASS',scope='REQUESTED_SAME_SHA_R0_CLEANUP_R1_CLEANUP_DEFAULT_OFF_RESTORE_SEQUENCE_ONLY',sourceCommit=sha,originalR0Gate='PASS',originalR1Gate='PASS',originalParentChildCleanupGate='PASS',restoreGate='PASS',actualCandidateSwitchesFalse=5,ownedArchivePrefixesEmpty=4,ciOriginalAttempt='FAIL',ciLatestAttempt='PASS',ciOriginalFailureCause='UNRESOLVED',businessReplays=0,matchedColdGate=summary['matchedNaturalColdGate'],causalBenefit='NOT_ESTABLISHED',qa09Gate='PARTIAL',p95Accepted=False,fullQa09Accepted=False,bindings={n:digest(root/n) for n in names},finishedAt=datetime.now(timezone.utc).isoformat())
(root/'completion.json').write_text(json.dumps(completion,indent=2)+'\n')
files={str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file()}
manifest=dict(gate='PARTIAL',seal='PASS',scope=completion['scope'],sourceCommit=sha,sealedAt=datetime.now(timezone.utc).isoformat(),originalR0Gate='PASS',originalR1Gate='PASS',restoreGate='PASS',matchedNaturalColdGate=summary['matchedNaturalColdGate'],causalBenefit='NOT_ESTABLISHED',p95Accepted=False,fullQa09Accepted=False,fileCount=len(files),files=files,documentBindings=documents,notes=['Original failed CI and blocked/pending artifact reads remain unchanged.','Observer summary output follows the original load end boundary; no subtraction or compiler-exclusive attribution.','No IAM/KMS change, capacity adjustment, resource restart, forced cold, additional samples or invitations.','Manifest excludes its own bytes and binds every other evidence file.'])
(root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
for n,h in files.items():assert digest(root/n)==h,n
print(json.dumps(dict(gate='PASS',qa09Gate='PARTIAL',files=len(files))))
