"""Seal a complete local verification without promoting it to hosted CI acceptance."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess

P = Path(__file__).parent
ROOT = P.resolve().parents[4]


def read(name):
    return json.loads((P / name).read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT,
                                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})


def main():
    execution = read('full-verify-attempt2.execution.json')
    assert execution['command'] == ['pnpm', 'verify']
    assert execution['status'] == 'PASS' and execution['exitCode'] == 0
    assert execution['sourceInputsUnchanged'] is True
    inputs = read(execution['sourceInputs'])
    assert git('rev-parse', 'HEAD').decode().strip() == inputs['baseCommit']
    for name, expected in inputs['files'].items():
        assert digest(ROOT / name) == expected, name
    suites = execution['suiteReceipts']
    assert len(suites) == 7
    assert {read(s['path'])['task'] for s in suites} == {f'QA-{i:02}' for i in range(2, 9)}
    for suite in suites:
        assert digest(P / suite['path']) == suite['sha256']
        receipt = read(suite['path'])
        assert receipt['status'] == 'PASS'
        if 'cleanup' in receipt:
            assert receipt['cleanup'] == 'PASS'
    expected_changes = {
        '.gitattributes', '.prettierignore', 'eslint.config.mjs',
        'packages/database/test/helpers/contract-cpu-probe.ts',
        'scripts/qa09-contract-cpu-proof.mjs', 'scripts/qa09-contract-cpu-proof.d.mts',
        'scripts/qa09-contract-cpu-proof.test.mjs',
    }
    assert set(git('diff', '--name-only').decode().splitlines()) == expected_changes
    assert not git('ls-files', 'build').strip()
    git('diff', '--check')
    git('diff', '--quiet', 'HEAD', '--', 'docs/audit/evidence/onboarding-first-request-2026-10-18',
        'docs/audit/evidence/onboarding-deploy-2026-10-18')
    git('diff', '--quiet', '24317c4cbe22318666c2ac7caae9e82f7e437eaa', '--',
        'apps', 'packages/database/src', 'packages/observability/src', 'infra', 'contracts',
        '.github', 'package.json', 'pnpm-lock.yaml')
    (P / 'working-tree.patch').write_bytes(git('diff', '--binary'))
    result = {
        'schemaVersion': '1.0', 'localOverallGate': 'PASS', 'scope': 'FULL_LOCAL_PNPM_VERIFY',
        'execution': execution, 'sourceInputs': inputs,
        'workingTreePatchSha256': digest(P / 'working-tree.patch'),
        'hostedFullCi': 'NOT_EXECUTED', 'lambdaFunctionalAcceptance': 'ACCEPTED_BY_USER',
        'additionalAwsPermissionsRequested': False, 'awsDeploymentExecuted': False,
        'productionSourceUnchanged': True, 'historicalOnboardingEvidenceUnchanged': True,
        'productionReady': False, 'fullQa09Accepted': False,
        'validatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    (P / 'local-validation.json').write_text(json.dumps(result, indent=2) + '\n')
    report = P.parents[2] / '本地整体Gate修复与复验-2026-10-18.md'
    files = {str(f.relative_to(P)): {'bytes': f.stat().st_size, 'sha256': digest(f)}
             for f in sorted(P.rglob('*')) if f.is_file() and f.name != 'manifest.json'}
    (P / 'manifest.json').write_text(json.dumps({
        'baseCommit': inputs['baseCommit'], 'files': files,
        'report': {'name': report.name, 'sha256': digest(report)},
    }, indent=2) + '\n')
    print(json.dumps({'localOverallGate': 'PASS', 'suiteGates': 7, 'files': len(files),
                      'hostedFullCi': 'NOT_EXECUTED'}))


if __name__ == '__main__':
    main()
