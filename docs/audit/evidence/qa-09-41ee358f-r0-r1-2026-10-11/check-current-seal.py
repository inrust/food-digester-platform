"""Local immutable evidence inventory. Never calls cloud or business services."""
import hashlib
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parents[3]
report = repo / 'docs/audit/QA-09-41ee358f自有边界摘要R0-R1目标复验-2026-10-11.md'
manifest = root / 'manifest.json'
sha = '41ee358fb92e4dae2ae4abba7eb9923996fe029b'


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def inventory():
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*'))
            if p.is_file() and p != manifest}


assert sys.argv[1:] in [['--seal'], ['--check']]
if sys.argv[1] == '--seal':
    assert not manifest.exists(), 'NO_RESEAL'
    for name in ['r0/unit-completion.json', 'r1/unit-completion.json',
                 'restore/restore-completion.json', 'restore/post-restoration-readonly.json',
                 'restore/owned-domain-readonly.json', 'restore/owned-build-terminal-bounded.json',
                 'final-live-readonly.json', 'final-checks/summary.json']:
        assert json.loads((root / name).read_text())['gate'] == 'PASS', name
    comparison = json.loads((root / 'comparison.json').read_text())
    assert comparison['matchedNaturalColdGate'] in ['INPUT_COMPATIBLE', 'NOT_OBSERVED']
    assert comparison['p95Accepted'] is False and comparison['fullQa09Accepted'] is False
    data = dict(gate='LOCAL_EVIDENCE_INTEGRITY_PASS', sourceCommit=sha,
                boundedSequenceGate='PASS', qa09Gate='PARTIAL',
                p95Accepted=False, fullQa09Accepted=False, files=inventory(),
                documents={str(report.relative_to(repo)): digest(report)})
    manifest.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
data = json.loads(manifest.read_text())
assert data['sourceCommit'] == sha and data['files'] == inventory(), 'EVIDENCE_INVENTORY_DRIFT'
for name, expected in data['documents'].items():
    assert digest(repo / name) == expected, 'DOCUMENT_DRIFT:' + name
print(json.dumps(dict(gate=data['gate'], sealedFiles=len(data['files']),
                     boundedSequenceGate=data['boundedSequenceGate'], qa09Gate=data['qa09Gate'],
                     p95Accepted=False, fullQa09Accepted=False)))
