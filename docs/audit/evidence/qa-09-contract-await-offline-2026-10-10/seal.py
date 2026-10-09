import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

root = Path('docs/audit/evidence/qa-09-contract-await-offline-2026-10-10')
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
read = lambda name: json.loads((root / name).read_text())
verify = read('verify-scoped-host.json')
assert verify['gate'] == 'PASS' and all(c['exit'] == 0 for c in verify['commands'])
entry = read('primary-matrix-entry.json')
assert entry['verifyReceiptSha256'] == sha(root / 'verify-scoped-host.json') and entry['parallelVerification'] is False
matrix = read('matrix-final/matrix.json')
assert matrix['gate'] == 'PASS' and len(matrix['rows']) == 11 and matrix['budget']['networkRequests'] == 0
for source in matrix['inputs']:
    assert sha(source['path']) == source['sha256'], source['path']
for row in matrix['rows']:
    assert sha(root / 'matrix-final' / row['receipt']) == row['sha256']
    assert (root / 'matrix-final' / (row['case'] + '.exit')).read_text().strip() == '0'
assert sum(len(r['samples']) for r in matrix['rows']) == 23
assert sum(s['checkpoint'] is not None for r in matrix['rows'] for s in r['samples']) == 9
for name in ['curl-transport.json', 'node-transport.json', 'decoded-source-scan.json', 'history-integrity.json']:
    assert read(name)['gate'] == 'PASS'
gates = sorted(root.glob('fdp-*-gate.json'))
assert len(gates) == 7 and all(json.loads(p.read_text())['status'] == 'PASS' for p in gates)
source_files = [
    'apps/cloud-api/src/admin/contract/service.ts',
    'apps/cloud-api/src/admin/contract/load-candidate.ts',
    'apps/cloud-api/test/admin-contract-load-candidate.test.ts',
    'packages/database/src/contract-load-observation.ts',
    'packages/database/test/contract-load-detail.test.ts',
    'packages/database/test/contract-await-offline.test.ts',
    'packages/observability/src/data-path.ts',
    'scripts/collect-qa09-contract-correlation.py',
    'scripts/qa09-contract-load-detail-proof.mjs',
    'scripts/qa09-contract-load-detail-proof.d.mts',
    'scripts/qa09-contract-load-detail-proof.test.mjs',
    'scripts/check-qa09-contract-phases.mjs',
    'scripts/qa09-matched-cold-inputs.mjs',
    'scripts/run-qa09-contract-await-offline.mjs',
    'scripts/analyze-qa09-contract-await.mjs',
]
docs = ['docs/管理后台开发任务清单.md', 'docs/audit/QA-09-合同await分界与默认关闭离线候选实施记录-2026-10-10.md', 'docs/dev/QA-09-合同await微任务分界与离线读取候选复验.md']
files = {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
manifest = {
    'gate': 'PARTIAL',
    'scope': 'OFFLINE_IMPLEMENTATION_AND_INDEPENDENT_UNAUTHENTICATED_TRANSPORT_ONLY',
    'sealedAt': datetime.now(timezone.utc).isoformat(),
    'baselineCommit': 'da0929b39ae29e0ba7113bb34c32b1554646c4e3',
    'implementationState': 'SOURCE_BYTES_BOUND_BEFORE_LOCAL_COMMIT_NO_PUSH',
    'implementationGate': 'PASS',
    'offlineMatrixGate': 'PASS',
    'functionalCandidateGate': 'PASS',
    'verifyEquivalentGate': 'PASS_EXCLUDING_UNRELATED_UNTRACKED_BUILD_LINT_FORMAT_ONLY',
    'originalVerifyGate': 'BLOCKED_UNRELATED_UNTRACKED_BUILD',
    'primaryMatrix': 'matrix-final/matrix.json',
    'preliminaryMatrix': 'matrix/matrix.json',
    'contractReadCandidate': False,
    'contractReadCandidateRuntimeWired': False,
    'newShaTargetGate': 'NOT_RUN',
    'target465msRetroactivelySplit': False,
    'targetModelCostShift': 'NOT_ESTABLISHED',
    'targetBenefit': 'NOT_ESTABLISHED',
    'networkNodeAttribution': 'UNRESOLVED',
    'p95Accepted': False,
    'fullQa09Accepted': False,
    'targetFixturesCreated': 0,
    'awsBusinessWrites': 0,
    'iamKmsCapacityChanges': 0,
    'independentUnauthenticatedGets': 18,
    'rawLogsWhitespacePreserved': True,
    'sourceFiles': {p: sha(p) for p in source_files},
    'documents': {p: sha(p) for p in docs},
    'fileCount': len(files),
    'files': files,
}
assert not (root / 'manifest.json').exists()
(root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'gate': manifest['gate'], 'implementationGate': 'PASS', 'evidenceFiles': len(files), 'codeFiles': len(source_files)}))
