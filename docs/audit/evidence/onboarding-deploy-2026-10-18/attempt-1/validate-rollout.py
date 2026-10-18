"""Validate linked execution receipts; run after fixture cleanup and project restore."""
from pathlib import Path
import json
import hashlib
import datetime

P = Path(__file__).parent
SOURCE = '24317c4cbe22318666c2ac7caae9e82f7e437eaa'


def read(name):
    return json.loads((P / name).read_text())


def main():
    before = read('db-before.receipt.json')
    migrated = read('db-after-migration.receipt.json')
    final = read('db-after-cleanup.receipt.json')
    assert before['snapshot']['onboardingSerialPrecheck']['groups'] == []
    assert before['snapshot']['onboardingSerialPrecheck']['status'] == 'PASS'
    assert before['snapshot']['counts']['onboarding_requests']['count'] == '0'
    for receipt in [migrated, final]:
        assert receipt['queryGate'] == receipt['migrationGate'] == receipt['schemaGate'] == 'PASS'
        assert receipt['manifest']['sourceCommit'] == SOURCE
        assert receipt['snapshot']['onboardingSerialPrecheck']['status'] == 'PASS'
        indexes = {i['indexname'] for i in receipt['snapshot']['onboardingSerialPrecheck']['indexDefinitions']}
        assert 'onboarding_requests_serial_number_key' in indexes
        assert 'onboarding_requests_one_pending_per_serial' not in indexes
    assert read('migration-verification.json')['gate'] == 'PASS'
    migration = read('migration.receipt.json')
    assert migration['sourceCommit'] == SOURCE
    assert migration['migrations'] == migration['dictionarySeed'] == 'PASS'
    assert read('cdk-deploy.execution.json')['exitCode'] == 0
    assert read('deployed-template-verification.json')['gate'] == 'PASS'
    assert 'onboarding-verify-20261018-exact-source' not in read('role-inline-policies-after.json')['PolicyNames']
    version = read('deployed-version.json')
    assert version['gate'] == 'PASS' and version['sourceCommit'] == SOURCE
    assert version['functionsVerified'] == len(version['functions']) == 19
    assert all(f['localAssetTreeMatches'] for f in version['functions'])
    api = read('acceptance.receipt.json')
    assert api['gate'] == 'PASS' and api['applicationCommit'] == SOURCE
    assert api['checks'] and all(c['result'] == 'PASS' for c in api['checks'])
    assert all(o['state'] == 'PASS' for o in api['operations'])
    required = {'first-request': 201, 'duplicate-pending': 409, 'admin-approve': 200, 'duplicate-approved': 409}
    for name, status in required.items():
        assert len([o for o in api['operations'] if o['name'] == name and o.get('status') == status]) == 1
    cleanup = read('fixture-cleanup.receipt.json')
    assert cleanup['gate'] == 'PASS' and cleanup['auditPreserved'] is True
    assert cleanup['plan'] == read('acceptance.receipt.json.cleanup-plan.json')
    assert cleanup['plan']['requestId'] == api['requestId']
    assert cleanup['plan']['deviceId'] == api['deviceId']
    assert cleanup['plan']['certificateIds'] == [api['certificateId']]
    assert cleanup['jobs'][0]['issued_certificate_id'] == api['certificateId']
    assert cleanup['certificates'][0]['claimed_at'] is not None
    assert cleanup['deleted']['onboarding_requests'] == cleanup['deleted']['devices'] == 1
    assert any(a['action'] == 'onboarding.request.approve' and a['result'] == 'SUCCESS' for a in cleanup['audit'])
    assert any(a['action'] == 'onboarding.request.approve' and a['actor_id'] == cleanup['requests'][0]['reviewed_by']
               for a in cleanup['audit'])
    assert read('cloud-cleanup-verification.json')['gate'] == 'PASS'
    assert read('readonly-project-restored.json')['gate'] == 'PASS'
    assert read('fixture-project-cleanup.json')['gate'] == 'PASS'
    assert read('linux-verify-project-cleanup.json')['gate'] == 'PASS'
    assert read('local-record-checks.json')['gate'] == 'PASS'
    for table in ['devices', 'device_certificates', 'device_public_keys', 'device_state_history',
                  'onboarding_requests', 'onboarding_provisioning_jobs', 'onboarding_proof_nonces']:
        assert before['snapshot']['preservationFingerprints'][table] == final['snapshot']['preservationFingerprints'][table], table
    changed = {k: {'before': v, 'after': final['snapshot']['preservationFingerprints'][k]}
               for k, v in before['snapshot']['preservationFingerprints'].items()
               if v != final['snapshot']['preservationFingerprints'][k]}
    assert set(changed) <= {'_prisma_migrations', 'audit_logs', 'auth_rate_limits'}, changed
    assert int(final['snapshot']['preservationFingerprints']['audit_logs']['count']) >= int(before['snapshot']['preservationFingerprints']['audit_logs']['count'])
    result = {
        'gate': 'PASS_ONBOARDING_TEST_ROLLOUT', 'sourceCommit': SOURCE,
        'validatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'databasePrecheck': 'PASS_NO_DUPLICATES', 'migration': 'PASS',
        'testDeployment': 'PASS_EXACT_TEMPLATE_AND_19_LAMBDA_PACKAGES',
        'apiWorkflow': 'PASS', 'apiCheckCount': len(api['checks']),
        'fixtureCleanup': 'PASS', 'temporaryProjectsCleaned': True,
        'readonlyProjectRestored': True, 'originalDeviceAndOnboardingRowsPreserved': True,
        'changedTableFingerprintsSincePreflight': changed,
        'independentLinuxVerification': read('linux-verification-disposition.json')['status'],
        'githubCi': 'NOT_STARTED_BILLING_LIMIT', 'localOverallGate': 'PARTIAL_EXISTING_CPU_PROFILE_FAILURES',
        'physicalDeviceHeartbeatTested': False, 'fullQa09Accepted': False, 'productionReady': False,
    }
    (P / 'rollout-validation.json').write_text(json.dumps(result, indent=2) + '\n')
    files = {str(f.relative_to(P)): {'bytes': f.stat().st_size, 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()}
             for f in sorted(P.rglob('*')) if f.is_file() and f.name != 'manifest.json' and '__pycache__' not in f.parts}
    report = P.parents[2] / 'Onboarding修复合并迁移与测试环境验收-2026-10-18.md'
    (P / 'manifest.json').write_text(json.dumps({'sourceCommit': SOURCE,
        'report': {'name': report.name, 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()},
        'files': files}, indent=2) + '\n')
    print(json.dumps({'gate': result['gate'], 'sourceCommit': SOURCE, 'files': len(files)}))


if __name__ == '__main__':
    main()
