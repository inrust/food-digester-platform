"""Check sealed local evidence bytes only; never contacts AWS or changes receipts."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
repo = root.parents[3]
manifest = json.loads((root / 'manifest.json').read_bytes())
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
files = {
    str(p.relative_to(root)): digest(p)
    for p in root.rglob('*')
    if p.is_file() and p != root / 'manifest.json'
}
assert files == manifest['files'], 'SEALED_EVIDENCE_BYTES_OR_INVENTORY_DRIFT'
for name, wanted in manifest['bindings'].items():
    assert digest(repo / name) == wanted, 'SEALED_SOURCE_OR_DOCUMENT_DRIFT:' + name
assert manifest['applicationSourceCommit'] == 'ad213fa27375369fc0320f1747b1490a6292a41b'
assert manifest['recordedGate'] == 'R0_R1_ORIGINAL_BUSINESS_CLEANUP_AND_OFF_RESTORE_PASS_QA09_PARTIAL'
assert manifest['originalUnknownStart'] == 'UNKNOWN'
assert manifest['fullQa09Accepted'] is False and manifest['p95Accepted'] is False
for mode in ['r0', 'r1']:
    unit = json.loads((root / mode / 'unit-completion.json').read_bytes())
    assert unit['gate'] == unit['originalExecutionGate'] == 'PASS'
    assert unit['cleanup'] == unit['independentEmptyAudit'] == 'PASS'
    assert unit['cleanupRecovery'] is False
assert json.loads((root / 'restore/post-restoration-readonly.json').read_bytes())['gate'] == 'PASS'
assert json.loads((root / 'final-checks/summary.json').read_bytes())['gate'] == 'PASS'
print(json.dumps({
    'gate': 'PASS',
    'scope': 'LOCAL_SEALED_EVIDENCE_INVENTORY_AND_SOURCE_DOCUMENT_BYTES_ONLY',
    'files': len(files),
    'bindings': len(manifest['bindings']),
    'applicationSourceCommit': manifest['applicationSourceCommit'],
    'originalUnknownStart': 'UNKNOWN',
    'fullQa09Accepted': False,
    'p95Accepted': False,
}))
