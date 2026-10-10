"""Seal completed new-SHA receipts locally; no AWS or business operation."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, subprocess

root = Path(__file__).resolve().parent
repo = root.parents[3]
sha = '0afe48384537c8c79ec6ce87276858120b9fd6ef'
assert not (root / 'manifest.json').exists(), 'ALREADY_SEALED'
summary = json.loads((root / 'comparison.json').read_text())
assert summary['gate'] == 'PARTIAL'
assert summary['businessPairGate'] == summary['cleanupPairGate'] == summary['restoreGate'] == 'PASS'
assert summary['causalBenefit'] == 'NOT_ESTABLISHED' and summary['p95Accepted'] is False and summary['fullQa09Accepted'] is False
assert json.loads((root / 'final-checks/summary.json').read_text())['gate'] == 'PASS'
assert json.loads((root / 'document-check.json').read_text())['gate'] == 'PASS'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip() == sha
assert not subprocess.check_output(['git', 'diff', sha, '--', 'apps', 'packages', 'contracts', 'infra', 'scripts', '.github', 'package.json', 'pnpm-lock.yaml'], cwd=repo)
subprocess.run(['git', 'diff', '--check'], cwd=repo, check=True)
for relative, expected in summary['bindings'].items():
    assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == expected
assert (root / 'restore/final-checks.step.exit').read_text().strip() == '0'
documents = ['docs/管理后台开发任务清单.md', 'docs/audit/QA-09-0afe483启动前只读恢复R0-R1目标复验-2026-10-10.md']
files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()}
entry = {m: json.loads((root / m / 'prestart-entry-gate.json').read_text()) for m in ['preflight', 'r0', 'r1', 'restore']}
manifest = dict(gate='PARTIAL', scope='ORIGINAL_SAME_SHA_R0_R1_BUSINESS_PHASE_CLEANUP_AND_DEFAULT_OFF_RESTORE', sourceCommit=sha,
    sealedAt=datetime.now(timezone.utc).isoformat(), r0OriginalGate='PASS', r1OriginalGate='PASS', restoreGate='PASS',
    matchedNaturalColdGate=summary['matchedNaturalColdGate'], causalBenefit='NOT_ESTABLISHED', p95Accepted=False, fullQa09Accepted=False,
    prestartRecovery={m: {k:v[k] for k in ['gate', 'recoveredFailures', 'actualTransientRecovery']} for m,v in entry.items()},
    fileCount=len(files), files=files,
    documentBindings={n: hashlib.sha256((repo / n).read_bytes()).hexdigest() for n in documents},
    notes=['Both original unit Gates, original parent/child cleanup and independent empty audits must pass.',
           'Local simulated failure recovery is distinct from actually observed target read recovery.',
           'No business replay, extra cold sampling, IAM/KMS or capacity adjustment.',
           'Historical failed and unknown-start evidence is unchanged.',
           'Manifest excludes its own bytes; all other files are bound.'])
(root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(dict(gate='PARTIAL', seal='PASS', fileCount=len(files))))
