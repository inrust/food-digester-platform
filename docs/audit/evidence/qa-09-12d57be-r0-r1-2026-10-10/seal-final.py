"""Seal the completed requested sequence locally, retaining failed control reads."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, subprocess

root = Path(__file__).resolve().parent
repo = root.parents[3]
sha = '12d57befe55be1e1abfd1e226c2d13cbace992dc'
assert not (root / 'manifest.json').exists(), 'ALREADY_SEALED'
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def read(name):
    return json.loads((root / name).read_text())
summary = read('comparison.json')
assert summary['gate'] == 'PARTIAL'
assert summary['businessPairGate'] == summary['cleanupPairGate'] == summary['restoreGate'] == 'PASS'
assert summary['causalBenefit'] == 'NOT_ESTABLISHED'
assert summary['p95Accepted'] is False and summary['fullQa09Accepted'] is False
for name in ['final-checks/summary.json', 'document-check.json', 'additional-proofs.json', 'log-read-provenance.json', 'restore-read-provenance.json', 'final-live-readonly.json']:
    assert read(name)['gate'] == 'PASS', name
for name, h in summary['bindings'].items():
    assert digest(root / name) == h
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip() == sha
assert not subprocess.check_output(['git', 'diff', sha, '--', 'apps', 'packages', 'contracts', 'infra', 'scripts', '.github', 'package.json', 'pnpm-lock.yaml'], cwd=repo)
subprocess.run(['git', 'diff', '--check'], cwd=repo, check=True)
names = ['comparison.json', 'r0/unit-completion.json', 'r1/unit-completion.json',
         'restore/restore-completion.json', 'restore/post-restoration-readonly.json',
         'restore/prestart-entry-gate.json', 'restore/owned-domain-readonly.json',
         'restore/owned-build-terminal-bounded.json', 'final-live-readonly.json',
         'final-checks/summary.json', 'additional-proofs.json', 'log-read-provenance.json', 'restore-read-provenance.json', 'document-check.json']
completion = dict(gate='PASS', scope='REQUESTED_SAME_SHA_R0_CLEANUP_R1_CLEANUP_DEFAULT_OFF_RESTORE_SEQUENCE_ONLY',
    sourceCommit=sha, originalR0Gate='PASS', originalR1Gate='PASS',
    originalParentChildCleanupGate='PASS', restoreGate='PASS',
    actualCandidateSwitchesFalse=4, ownedArchivePrefixesEmpty=4,
    originalR0WaitReadGate='FAIL', effectiveR0WaitReadGate='PASS',
    originalRestoreWaitReadGate='FAIL', effectiveRestoreWaitReadGate='PASS',
    readRecoveryNewDispatches=0, businessReplays=0,
    matchedColdGate=summary['matchedNaturalColdGate'], causalBenefit='NOT_ESTABLISHED',
    qa09Gate='PARTIAL', p95Accepted=False, fullQa09Accepted=False,
    bindings={n:digest(root / n) for n in names}, finishedAt=datetime.now(timezone.utc).isoformat())
(root / 'completion.json').write_text(json.dumps(completion, indent=2) + '\n')
files = {str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file()}
documents = read('document-check.json')['documentBindings']
for n, h in documents.items():
    assert digest(repo / n) == h
manifest = dict(gate='PARTIAL', seal='PASS', scope=completion['scope'], sourceCommit=sha,
    sealedAt=datetime.now(timezone.utc).isoformat(), originalR0Gate='PASS', originalR1Gate='PASS',
    restoreGate='PASS', originalR0WaitReadGate='FAIL', effectiveR0WaitReadGate='PASS',
    originalRestoreWaitReadGate='FAIL', effectiveRestoreWaitReadGate='PASS',
    matchedNaturalColdGate=summary['matchedNaturalColdGate'], causalBenefit='NOT_ESTABLISHED',
    p95Accepted=False, fullQa09Accepted=False, fileCount=len(files), files=files,
    documentBindings=documents, notes=[
        'Original failed workflow status read and PARTIAL log reads remain unchanged.',
        'Exact read recovery performed no dispatch, business replay or extra cold sampling.',
        'Both original parent/child cleanup Gates pass without compensating cleanup.',
        'No IAM/KMS, capacity adjustment, shared resource restart or invitation sending.',
        'Manifest excludes its own bytes and binds all other evidence files.'])
(root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
for n, h in files.items():
    assert digest(root / n) == h
print(json.dumps(dict(gate='PASS', qa09Gate='PARTIAL', files=len(files))))
