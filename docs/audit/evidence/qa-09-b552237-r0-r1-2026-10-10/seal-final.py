"""Seal completed evidence locally. Never replay AWS or business operations."""
from pathlib import Path
from datetime import datetime, timezone
import ast
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parent
repo = root.parents[3]
sha = 'b5522378aebca9340a0767b53ed3bab846ffc080'
assert not (root / 'manifest.json').exists(), 'ALREADY_SEALED'
summary = json.loads((root / 'comparison.json').read_text())
assert summary['gate'] == 'PARTIAL'
assert summary['r0OriginalGate'] == 'FAIL' and summary['r1Gate'] == 'NOT_RUN'
assert summary['restoreGate'] == summary['compensatingCleanupGate'] == 'PASS'
assert json.loads((root / 'final-checks/summary.json').read_text())['gate'] == 'PASS'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip() == sha
assert not subprocess.check_output([
    'git', 'diff', sha, '--', 'apps', 'packages', 'contracts', 'infra',
    'scripts', '.github', 'package.json', 'pnpm-lock.yaml'
], cwd=repo)
subprocess.run(['git', 'diff', '--check'], cwd=repo, check=True)
for relative, expected in summary['bindings'].items():
    assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == expected
for name in ['final-checks.exit', 'document-check.exit']:
    assert (root / name).read_text().strip() == '0'
for path in root.rglob('*.py'):
    ast.parse(path.read_bytes(), filename=str(path))
files = {
    str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
    for p in sorted(root.rglob('*')) if p.is_file()
}
documents = [
    'docs/管理后台开发任务清单.md',
    'docs/audit/QA-09-b552237合同await微任务分界R0-R1目标复验-2026-10-10.md',
]
manifest = {
    'gate': 'PARTIAL',
    'scope': 'FAILED_ORIGINAL_R0_EXACT_CLEANUP_AND_SAME_SHA_DEFAULT_OFF_RESTORE',
    'sourceCommit': sha,
    'sealedAt': datetime.now(timezone.utc).isoformat(),
    'r0OriginalGate': 'FAIL',
    'r1Gate': 'NOT_RUN',
    'compensatingCleanupGate': 'PASS',
    'restoreGate': 'PASS',
    'matchedNaturalColdGate': 'NOT_RUN',
    'causalBenefit': 'NOT_ESTABLISHED',
    'p95Accepted': False,
    'fullQa09Accepted': False,
    'fileCount': len(files),
    'files': files,
    'documentBindings': {
        name: hashlib.sha256((repo / name).read_bytes()).hexdigest()
        for name in documents
    },
    'notes': [
        'Original failed receipts are immutable; cleanup PASS does not upgrade execution.',
        'No R1 dispatch, extra business replay, IAM/KMS or capacity adjustment.',
        'Manifest excludes its own bytes; all other files are bound.',
    ],
}
(root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'gate': 'PARTIAL', 'seal': 'PASS', 'fileCount': len(files)}))
