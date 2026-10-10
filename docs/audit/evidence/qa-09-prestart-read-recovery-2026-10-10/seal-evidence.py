"""Content-bound local implementation evidence. Never calls AWS or dispatches a workflow."""
from pathlib import Path
from datetime import datetime, timezone
import ast, hashlib, json, re

root = Path(__file__).resolve().parent
repo = root.parents[3]
assert not (root / 'manifest.json').exists()
gate = json.loads((root / 'implementation-gate.json').read_text())
assert gate['gate'] == 'PASS' and gate['targetR0R1'] == 'NOT_RUN'
assert json.loads((root / 'final-document-check.json').read_text())['gate'] == 'PASS'
for name, expected in gate['sourceSha256'].items():
    assert hashlib.sha256((repo / name).read_bytes()).hexdigest() == expected
docs = [
    'docs/audit/QA-09-父清理启动前只读有界恢复实施记录-2026-10-10.md',
    'docs/dev/QA-09-父清理启动前只读有界恢复复验.md',
    'docs/管理后台开发任务清单.md',
]
patterns = [rb'(?:AKIA|ASIA)[A-Z0-9]{16}', rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}', rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----']
files = {}
for path in sorted(root.rglob('*')):
    if not path.is_file():
        continue
    data = path.read_bytes()
    assert not any(re.search(pattern, data) for pattern in patterns), 'CREDENTIAL_PATTERN_DETECTED'
    if path.suffix == '.py':
        ast.parse(data, filename=str(path))
    if path.suffix == '.json':
        json.loads(data)
    files[str(path.relative_to(root))] = hashlib.sha256(data).hexdigest()
result = {
    'gate': 'PASS', 'scope': 'LOCAL_IMPLEMENTATION_ONLY',
    'sealedAt': datetime.now(timezone.utc).isoformat(),
    'baseCommit': gate['baseCommit'],
    'implementationCommit': 'RESOLVE_FROM_CONTAINING_GIT_COMMIT',
    'sourceSha256': gate['sourceSha256'],
    'documentBindings': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in docs},
    'fileCount': len(files), 'files': files,
    'newShaHostedCi': 'NOT_RUN', 'newSha19Artifacts': 'NOT_RUN', 'targetR0R1': 'NOT_RUN',
    'actualAwsTransientRecovery': 'NOT_RUN',
    'qa09Gate': 'PARTIAL', 'fullQa09Accepted': False, 'p95Accepted': False,
    'notes': ['All evidence except manifest itself is hash-bound.', 'Initial sandbox EPERM failure is preserved.', 'No target execution or historical receipt upgrade.'],
}
(root / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'gate': 'PASS', 'scope': result['scope'], 'fileCount': len(files), 'targetGate': 'NOT_RUN'}))
