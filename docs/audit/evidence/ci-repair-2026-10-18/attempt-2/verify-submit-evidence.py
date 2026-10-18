"""Read back immutable local Gate receipts and bind the reviewed patch before commit."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

P = Path(__file__).resolve().parent
ROOT = P.parents[4]
LOCAL = ROOT / 'docs/audit/evidence/local-gate-2026-10-18/attempt-1'
PATCH_FILES = [
    '.gitattributes', '.prettierignore', 'eslint.config.mjs',
    'packages/database/test/helpers/contract-cpu-probe.ts',
    'scripts/qa09-contract-cpu-proof.mjs', 'scripts/qa09-contract-cpu-proof.d.mts',
    'scripts/qa09-contract-cpu-proof.test.mjs',
]


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def main():
    manifest = read(LOCAL / 'manifest.json')
    for name, entry in manifest['files'].items():
        path = LOCAL / name
        assert path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256'], name
    local_report = LOCAL.parents[2] / manifest['report']['name']
    assert digest(local_report) == manifest['report']['sha256']
    validation = read(LOCAL / 'local-validation.json')
    assert validation['localOverallGate'] == 'PASS'
    execution = read(LOCAL / 'full-verify-attempt2.execution.json')
    assert execution == validation['execution']
    assert execution['command'] == ['pnpm', 'verify'] and execution['exitCode'] == 0
    assert execution['status'] == 'PASS' and execution['sourceInputsUnchanged'] is True
    inputs = read(LOCAL / execution['sourceInputs'])
    assert inputs == validation['sourceInputs']
    base = inputs['baseCommit']
    git('merge-base', '--is-ancestor', base, 'HEAD')
    for name, sha in inputs['files'].items():
        assert digest(ROOT / name) == sha, name
    patch = git('diff', '--binary', base, '--', *PATCH_FILES)
    assert patch == (LOCAL / 'working-tree.patch').read_bytes()
    assert hashlib.sha256(patch).hexdigest() == validation['workingTreePatchSha256']
    assert {read(LOCAL / s['path'])['task'] for s in execution['suiteReceipts']} == {f'QA-{i:02}' for i in range(2, 9)}
    for suite in execution['suiteReceipts']:
        assert digest(LOCAL / suite['path']) == suite['sha256']
        result = read(LOCAL / suite['path'])
        assert result['status'] == 'PASS'
        if 'cleanup' in result:
            assert result['cleanup'] == 'PASS'
    preserved = [
        'docs/audit/evidence/onboarding-first-request-2026-10-18',
        'docs/audit/evidence/onboarding-deploy-2026-10-18',
        'docs/audit/Onboarding首次申请去库存前置修复-2026-10-18.md',
        'docs/audit/Onboarding修复合并迁移与测试环境验收-2026-10-18.md',
    ]
    git('diff', '--quiet', base, '--', *preserved)
    git('diff', '--quiet', base, '--', 'apps', ':(glob)packages/*/src/**', 'contracts',
        'infra', '.github', 'package.json', 'pnpm-lock.yaml')
    assert not git('ls-files', 'build').strip()
    confirmation = read(P / 'user-confirmation.json')
    assert confirmation['independentLinuxVerification'] == 'NOT_REQUIRED_CONFIRMED_BY_USER'
    assert confirmation['gateAcceptedByUser'] is True
    diagnosis = read(P / 'github-diagnosis.json')
    for workflow in diagnosis:
        assert workflow['headSha'] == base and workflow['conclusion'] == 'failure'
        assert workflow['jobs'] and all(j['steps'] == 0 for j in workflow['jobs'])
        assert any('The job was not started' in a['message'] and 'payments' in a['message']
                   for a in workflow['annotations'])
    result = {
        'gate': 'PASS_PATCH_AND_EVIDENCE_REVIEW', 'baseCommit': base,
        'localOverallGate': 'PASS', 'fullLocalVerifyExitCode': 0,
        'sourceInputs': inputs['files'], 'workingTreePatchSha256': validation['workingTreePatchSha256'],
        'localManifestFilesVerified': len(manifest['files']), 'integrationGatesVerified': 7,
        'historicalOnboardingEvidenceUnchanged': True, 'productionSourceUnchanged': True,
        'independentLinuxVerification': confirmation['independentLinuxVerification'],
        'hostedFullCi': 'NOT_EXECUTED_BILLING_LIMIT', 'newFullVerifyExecuted': False,
        'awsDeploymentExecuted': False, 'productionReady': False, 'fullQa09Accepted': False,
        'reviewedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    (P / 'submit-review.json').write_text(json.dumps(result, indent=2) + '\n')
    report = ROOT / 'docs/audit/CI诊断修复提交复核-2026-10-18.md'
    files = {f.name: {'bytes': f.stat().st_size, 'sha256': digest(f)}
             for f in sorted(P.iterdir()) if f.is_file() and f.name != 'manifest.json'}
    (P / 'manifest.json').write_text(json.dumps({
        'baseCommit': base, 'files': files,
        'report': {'name': report.name, 'sha256': digest(report)},
    }, indent=2) + '\n')
    print(json.dumps({'gate': result['gate'], 'exactPatchMatches': True,
                      'localEvidenceFilesVerified': len(manifest['files']), 'hostedFullCi': result['hostedFullCi']}))


if __name__ == '__main__':
    main()
