"""Seal completed local checks and bounded transport receipts; never accepts AWS/P95."""
import hashlib
import json
import re
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
sha = lambda b: hashlib.sha256(b).hexdigest()
for name in ['verify', 'targeted-final-vitest', 'targeted-final-node', 'offline-validated', 'tls-node', 'tls-curl', 'final-secrets']:
    assert (ROOT / (name + '.exit')).read_text().strip() == '0', name
summary = json.loads((ROOT / 'offline-validated/summary.json').read_text())
assert summary['gate'] == 'PASS' and len(summary['rows']) == 9
for item in summary['sources']:
    assert sha((REPO / item['path']).read_bytes()) == item['sha256'], item['path']
for row in summary['rows']:
    assert row['gate'] == 'PASS' and row['noPreQueryCheckout']
    assert row['counts'] == {'checkouts': 2, 'queries': 2, 'releases': 2, 'activeLeases': 0, 'peakLeases': 1, 'pools': 1, 'poolMaxima': [1]}
for name, count in [('tls-node', 12), ('tls-curl', 6)]:
    receipt = json.loads((ROOT / (name + '.json')).read_text())
    assert receipt['gate'] == 'PASS' and len(receipt['rows']) == count
    assert not receipt['p95Accepted'] and not receipt['fullQa09Accepted']
    assert all(row['status'] == 401 for row in receipt['rows'])
checks = {}
for name in ['device-contracts', 'iot-integration', 'core-api-integration', 'admin-e2e', 'security', 'reliability', 'prototype-regression']:
    source = Path('/tmp/fdp-' + name + '-gate.json')
    value = json.loads(source.read_bytes())
    assert value['status'] == 'PASS', name
    target = ROOT / ('local-' + name + '-gate.json')
    target.write_bytes(source.read_bytes())
    checks[name] = {'gate': value['status'], 'sha256': sha(target.read_bytes()), 'scope': 'LOCAL_SUITE_NOT_TARGET_RECEIPT'}
source_paths = [
    'apps/cloud-api/src/admin/user/service.ts',
    'apps/cloud-api/src/admin/user/account-read-candidate.ts',
    'apps/cloud-api/test/admin-account-read-candidate.test.ts',
    'packages/database/src/client-preparation.ts',
    'packages/database/test/client-preparation.test.ts',
    'packages/database/test/observed-pg.test.ts',
    'packages/observability/src/data-path.ts',
    'scripts/analyze-qa09-account-phases.mjs',
    'scripts/check-qa09-contract-phases.mjs',
    'scripts/qa09-client-split-proof.mjs',
    'scripts/qa09-client-split-proof.test.mjs',
    'scripts/qa09-matched-cold-inputs.mjs',
    'scripts/qa09-matched-cold-inputs.test.mjs',
    'scripts/qa09-prisma-preparation-diagnostic.mjs',
]
result = {
    'task': 'QA-09', 'gate': 'LOCAL_PASS_TARGET_NOT_RUN',
    'scope': 'FIRST_ORM_PUBLIC_BOUNDARY_SPLIT_OFFLINE_PARAMETERIZED_CANDIDATE_MATCHED_INPUTS_AND_INDEPENDENT_TRANSPORT',
    'implementationParentCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
    'candidateDefault': False, 'candidateRuntimeWired': False,
    'candidateTarget': 'NOT_RUN_NO_RECEIPT', 'newSplitTarget': 'NOT_RUN_NO_RECEIPT',
    'matchedNaturalColdTarget': 'NOT_RUN_NO_RECEIPT', 'causalBenefit': 'NOT_ESTABLISHED',
    'p95Accepted': False, 'fullQa09Accepted': False, 'qa09Gate': 'PARTIAL',
    'tcpTlsGate': 'PASS_BOUNDED_UNAUTHENTICATED_TRANSPORT_ONLY', 'networkNodeAttribution': 'UNRESOLVED',
    'newCloudFixtures': 0, 'iamKmsOrCapacityChanged': False,
    'tests': {'fullVerifyExit': 0, 'application': 1436, 'contract': 302, 'scripts': 640, 'browser': 36, 'targetedVitest': 51, 'targetedNode': 74, 'freshOfflineProcesses': 9, 'localSuites': checks},
    'sourceHashes': {p: sha((REPO / p).read_bytes()) for p in source_paths},
    'documentHashes': {p: sha((REPO / p).read_bytes()) for p in ['docs/audit/QA-09-首次ORM准备分段与参数化只读离线候选实施记录-2026-10-07.md', 'docs/dev/QA-09-首次ORM准备与匹配自然冷对照复验.md', 'docs/管理后台开发任务清单.md']},
    'preservedFailures': ['verify-first-lint', 'verify-second-phase-expectation', 'targeted-node'],
    'next': 'DEFAULT_OFF_ACCOUNT_READ_HOOK_AND_DEPLOYMENT_INPUT_CONFIG_CLOSURE_THEN_SAME_SHA_TARGET_SPLIT_R0_R1_CLEANUP_RESTORE',
}
(ROOT / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
files = {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(ROOT.rglob('*')) if p.is_file() and p.name != 'manifest.json'}
(ROOT / 'manifest.json').write_text(json.dumps({'gate': 'SEALED', 'algorithm': 'SHA256', 'files': files}, indent=2) + '\n')
print(json.dumps({'gate': result['gate'], 'sealedFiles': len(files), 'qa09Gate': result['qa09Gate']}))
