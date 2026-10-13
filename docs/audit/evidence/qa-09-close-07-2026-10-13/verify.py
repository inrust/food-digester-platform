"""Content-bound reliability evidence. Historical failure/unknown outcomes never become PASS."""
from pathlib import Path
import base64
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
sha = lambda b: hashlib.sha256(b).hexdigest()
load = lambda name: json.loads((ROOT / name).read_bytes())
version = load('application-version.json')
assert version['gate'] == 'PASS' and len(version['lambdaArtifacts']) == 19
assert all(a['matches'] and a['artifactSha256'] == a['codeSha256'] for a in version['lambdaArtifacts'])
assert version['sourceCommit'] == 'dade6d950eb5fc681f9ab8c876762de5ffc77f4f'
assert load('api-entry-config.json')['gate'] == 'PASS'
base = load('reconciliation-before-v2.json')
assert base['targetCommit'] == version['sourceCommit']
assert base['historical'][0]['roles'] == [{'role': 'PlatformSuperAdmin', 'sent': 0}, {'role': 'PlatformOperator', 'sent': 0}]
assert base['historical'][1]['gate'] == 'BLOCKED'
assert base['historical'][2]['correctedClaim'] is False
assert base['historical'][-1]['originalExecutionGate'] == 'FAIL'
for ref in base['refs']:
    assert sha((REPO / ref['path']).read_bytes()) == ref['sha256'], ref['path']
# All three historical trees/configurations remain historical, including recovered cleanup.
assert len(base['comparisons']) == 2
assert all(any(not p['equal'] for p in comparison) for comparison in base['comparisons'].values())
for name, commit in [('qa-09-close-01-2026-10-12', 'dade6d950eb5fc681f9ab8c876762de5ffc77f4f'), ('qa-09-ad213fa-r0-r1-2026-10-12', '6504b635705b631e93240780da1665f4ad12a313')]:
    root = ROOT.parent / name
    manifest = json.loads((root / 'manifest.json').read_bytes())
    files = {str(p.relative_to(root)): sha(p.read_bytes()) for p in root.rglob('*') if p.is_file() and p.name != 'manifest.json'}
    extras = set(files) - set(manifest['files'])
    assert extras <= ({'verification.json'} if name == 'qa-09-close-01-2026-10-12' else set()), name
    for extra in extras:
        assert sha(subprocess.check_output(['git', 'show', commit + ':' + str((root / extra).relative_to(REPO))], cwd=REPO)) == files[extra]
    assert {k: v for k, v in files.items() if k not in extras} == manifest['files'], name
    for path, wanted in manifest['bindings'].items():
        assert sha(subprocess.check_output(['git', 'show', commit + ':' + path], cwd=REPO)) == wanted, path
# Current receipts are scoped; never replace the original all-table or direct-submission outcomes.
final_version = load('final-application-version.json')
assert final_version['gate'] == 'PASS' and final_version['sourceCommit'] == version['sourceCommit']
assert len(final_version['lambdaArtifacts']) == 19
assert all(a['matches'] and a['artifactSha256'] == a['codeSha256'] for a in final_version['lambdaArtifacts'])
config = load('api-final-config.json')
assert config['gate'] == 'PASS'
assert config['config']['pool'] == '1' and config['config']['memory'] == 512
assert config['concurrency']['ReservedConcurrentExecutions'] == 12
assert all(config['config'][k] == 'false' for k in ['preconnect', 'accountReadCandidate', 'contractLoadDetail', 'contractPublicBoundaries', 'contractObserverCost'])
assert {a['name']: a['codeSha256'] for a in version['lambdaArtifacts']} == {a['name']: a['codeSha256'] for a in final_version['lambdaArtifacts']}
for prefix in ['target.json', 'target-v2.json']:
    parent = load(prefix)
    assert parent['finishedAt'] and not parent.get('cleanupHold')
    assert all(c['result'] == 'PASS' or c['type'] == 'identity-refresh-before-cleanup' for c in parent['cleanup'])
    assert len([c for c in parent['cleanup'] if c['type'] == 'iot-certificate' and c['result'] == 'PASS']) == 10
first = load('target.json')
assert first['gate'] == 'FAIL' and first['failure']['code'] == 'PUBACK_TIMEOUT'
parent = load('target-v2.json')
assert parent['gate'] == 'PASS' and parent['sourceCommit'] == version['sourceCommit']
assert len(parent['devices']) == 10 and len(parent['customers']) == 2
child = load('target-v2.json.reliability.json')
assert child['gate'] == 'PARTIAL' and child['finishedAt'] and child['businessCleanup'] == 'PASS'
assert child['versionSha256'] == sha((ROOT / 'application-version.json').read_bytes())
assert child['replayGate'] == 'PASS_NONEMPTY_EXACT_SCOPE_REPLAY'
assert child['replayConsumption']['gate'] == 'PASS_EXACT_DUPLICATE_CONSUMPTION'
assert child['queueConsumptionGate'] == 'NOT_RUN_NO_SUBMISSION' and child['dedupGate'] == 'NO_RECEIPT'
assert child['submission']['gate'] == 'BLOCKED_PERMISSION_NO_RETRY'
assert child['replayAuditGate'] == 'PASS' and child['fullQa09Accepted'] is False
assert child['replayProducerToSpecificSqsIdClaimed'] is False
assert child['jobs'][0]['view']['resultSummary']['sent'] == 1
assessment = load('hourly-dedup-assessment.json')
assert assessment['gate'] == 'PASS_HOURLY_ARCHIVE_DEDUP_SCOPE'
assert assessment['dailyGate'] == 'NOT_RUN_NO_DAILY_ROWS'
assert assessment['fullDedupGateChanged'] is False and assessment['fullQa09Accepted'] is False
assert assessment['originalReliabilityGate'] == 'PARTIAL' and assessment['originalFullDedupGate'] == 'NO_RECEIPT'
assert assessment['originalDirectSubmissionGate'] == 'BLOCKED_PERMISSION_NO_RETRY'
for ref in assessment['bindings']:
    assert sha((REPO / ref['path']).read_bytes()) == ref['sha256'], ref['path']
for name, gate in [('first-final-readonly.json', 'FAIL'), ('final-readonly.json', 'PASS')]:
    final = load(name)
    assert final['gate'] == 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' and final['finishedAt']
    assert final['originalExecutionGate'] == gate and final['businessWrites'] == 0
    parent_name = 'target.json' if gate == 'FAIL' else 'target-v2.json'
    assert final['parentSha256'] == sha((ROOT / parent_name).read_bytes())
    db_path = REPO / final['databaseReceipt']
    assert final['databaseSha256'] == sha(db_path.read_bytes())
    db = json.loads(db_path.read_bytes())
    assert db['gate'] == 'PASS' and db['build']['status'] == 'SUCCEEDED'
    assert db['result']['gate'] == 'PASS' and db['result']['empty'] is True
    assert db['result']['devices'] == db['result']['certificates'] == db['result']['onboardingRequests'] == []
    assert final['iamKmsOrCapacityWrites'] == 0 and final['fullQa09Accepted'] is False
    assert len(final['archives']) == 6 and all(a['versions'] == a['markers'] == 0 and not a['truncated'] for a in final['archives'])
    assert len(final['identities']) == 1 and final['identities'][0]['count'] == 0
    assert len(final['builds']) == (6 if gate == 'FAIL' else 12)
    assert all(b['status'] == 'SUCCEEDED' for b in final['builds'])
after = load('reconciliation-after.json')
assert after['gate'] == 'PASS_INVENTORY_QA09_PARTIAL' and after['fullQa09Accepted'] is False
assert len(after['artifactComparisons']) == 8
assert all(not c['identicalCode'] for c in after['artifactComparisons'])
assert after['current']['gate'] == 'PARTIAL' and after['current']['dedupGate'] == 'NO_RECEIPT'
# Independently decode and scan frozen source/metadata. No raw payload, token or private key receipt.
source_count = 0
for p in ROOT.rglob('*.json'):
    def scan(value):
        global source_count
        if isinstance(value, dict):
            if 'sourceBase64' in value:
                raw = base64.b64decode(value['sourceBase64'], validate=True)
                expected = value.get('sha256') or value.get('sourceHash')
                if expected: assert sha(raw) == expected, p
                scan(raw.decode())
                source_count += 1
            for key, item in value.items():
                if key != 'sourceBase64': scan(item)
        elif isinstance(value, list):
            for item in value: scan(item)
        elif isinstance(value, str):
            assert not re.search(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bghp_[A-Za-z0-9]{36}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}', value), p
    scan(json.loads(p.read_bytes()))
if (ROOT / 'manifest.json').exists():
    manifest = load('manifest.json')
    files = {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in ROOT.rglob('*') if p.is_file() and p.name != 'manifest.json'}
    assert files == manifest['files']
    for path, wanted in manifest['bindings'].items(): assert sha((REPO / path).read_bytes()) == wanted, path
print(json.dumps({'gate': 'PASS_INTEGRITY_ONLY', 'frozenSources': source_count, 'historicalFailuresPreserved': True}))
