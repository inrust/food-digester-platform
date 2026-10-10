"""Local evidence closure only. No AWS access, deploy or business replay."""
from pathlib import Path
from datetime import datetime, timezone
import ast, hashlib, json, re, shutil, subprocess

root = Path(__file__).resolve().parent
repo = root.parents[3]
assert not (root / 'implementation-gate.json').exists()
initial = json.loads((root / 'local-checks.json').read_text())
remaining = json.loads((root / 'remaining-checks.json').read_text())
assert initial['gate'] == 'FAIL' and remaining['gate'] == 'PASS'
assert len(initial['results']) == 6 and initial['results'][-1]['name'] == 'test'
assert all(x['exitCode'] == 0 for x in initial['results'][:-1])
assert initial['results'][-1]['exitCode'] != 0
assert 'listen EPERM' in (root / 'test.stdout.log').read_text()
assert len(remaining['results']) == 18 and all(x['exitCode'] == 0 for x in remaining['results'])
assert 'pass 64' in (root / 'focused.stdout.log').read_text()
text = (root / 'remaining-test.stdout.log').read_text()
assert '1522 passed' in text and re.search(r'pass 302\b', text) and re.search(r'pass 810\b', text)
assert '36 passed' in (root / 'remaining-check-admin-web-e2e.stdout.log').read_text()
local_gates = []
for name in ['device-contracts', 'iot-integration', 'core-api-integration', 'admin-e2e-suite', 'security-suite', 'reliability-suite', 'prototype-regression']:
    source = Path('/tmp/fdp-prestart-test-' + name + '.json')
    dest = root / ('gate-' + name + '.json')
    assert not dest.exists()
    data = json.loads(source.read_text())
    assert data['status'] == 'PASS', name
    shutil.copyfile(source, dest)
    local_gates.append({'file': dest.name, 'status': data['status'], 'scope': data.get('scope'), 'awsTargetAcceptance': data.get('awsTargetAcceptance')})

previous = repo / 'docs/audit/evidence/qa-09-b552237-r0-r1-2026-10-10'
old_bytes = (previous / 'manifest.json').read_bytes()
old = json.loads(old_bytes)
for name, expected in old['files'].items():
    assert hashlib.sha256((previous / name).read_bytes()).hexdigest() == expected
old_report = 'docs/audit/QA-09-b552237合同await微任务分界R0-R1目标复验-2026-10-10.md'
assert hashlib.sha256((repo / old_report).read_bytes()).hexdigest() == old['documentBindings'][old_report]
assert old['r0OriginalGate'] == 'FAIL' and old['r1Gate'] == 'NOT_RUN'
sources = ['scripts/qa09-operation-observation.mjs', 'scripts/qa09-ten-device-bridge.mjs', 'scripts/qa09-prestart-read.test.mjs', 'scripts/qa09-fixture-cli-observation.test.mjs']
for name in sources:
    subprocess.run(['node', '--check', str(repo / name)], check=True, capture_output=True)
assert not subprocess.check_output(['git', 'diff', '--', 'apps', 'packages', 'contracts', 'infra', '.github', 'package.json', 'pnpm-lock.yaml'], cwd=repo)
subprocess.run(['git', 'diff', '--check'], cwd=repo, check=True)
for path in root.glob('*.py'):
    ast.parse(path.read_bytes(), filename=str(path))
patterns = [rb'(?:AKIA|ASIA)[A-Z0-9]{16}', rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}', rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----']
for path in [*root.rglob('*'), *(repo / name for name in sources)]:
    if path.is_file():
        assert not any(re.search(pattern, path.read_bytes()) for pattern in patterns), 'CREDENTIAL_PATTERN_DETECTED'
result = {
    'gate': 'PASS', 'scope': 'LOCAL_IMPLEMENTATION_FAILURE_MATRIX_AND_VERIFY_EQUIVALENT_ONLY',
    'finishedAt': datetime.now(timezone.utc).isoformat(),
    'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip(),
    'focusedTests': 64, 'applicationTests': 1522, 'contractTests': 302, 'scriptTests': 810, 'mainE2eTests': 36,
    'verifyEquivalentSteps': 22, 'initialSandboxEpermPreserved': True,
    'userUntrackedBuildExcludedFromLintFormatOnly': True,
    'sourceSha256': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in sources},
    'localQa02To08': local_gates,
    'historicalEvidenceFilesUnchanged': len(old['files']) + 1,
    'historicalManifestSha256': hashlib.sha256(old_bytes).hexdigest(),
    'historicalR0Gate': 'FAIL', 'historicalR1Gate': 'NOT_RUN',
    'applicationSqlInfraWorkflowUnchanged': True,
    'newShaHostedCi': 'NOT_RUN', 'newSha19Artifacts': 'NOT_RUN', 'targetR0R1': 'NOT_RUN',
    'actualAwsTransientRecovery': 'NOT_RUN', 'iamKmsCapacityChanges': False,
    'fullQa09Accepted': False, 'p95Accepted': False,
}
(root / 'implementation-gate.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['gate', 'scope', 'focusedTests', 'scriptTests', 'historicalEvidenceFilesUnchanged', 'targetR0R1']}))
