"""Close exact already-started readonly audit recovery; preserve the original FAIL."""
from pathlib import Path
import base64, datetime, hashlib, json, subprocess

root = Path(__file__).resolve().parent
p = root / 'restore'
sha = '0afe48384537c8c79ec6ce87276858120b9fd6ef'
out = p / 'post-restoration-readonly.json'
assert not out.exists()
bindings = {}
def read(n):
    b = (p / n).read_bytes(); bindings[n] = hashlib.sha256(b).hexdigest()
    return json.loads(b)
def digest(n): return hashlib.sha256((p / n).read_bytes()).hexdigest()
restore = read('restore-completion.json')
assert restore['gate'] == 'PASS' and restore['sourceCommit'] == sha
for n, h in restore['bindings'].items(): assert digest(n) == h
original = read('database-empty-audit.json')
prep = read('database-empty-audit.json.preparation.json')
started = read('database-empty-audit.json.started.json')
recovered = read('database-empty-audit.recovered.json')
assert original['gate'] == recovered['originalGate'] == 'FAIL'
assert original['failure']['code'] == 'AWS_batch-get-builds_CLI_READ_TIMEOUT'
assert original['failure']['kind'] == 'STARTED_BUILD_READ_OR_VERIFICATION'
assert original['failure']['recoveryAction'] == 'EXACT_EXISTING_BUILD_READ_ONLY'
assert recovered['gate'] == 'PASS' and recovered['scope'] == 'EXACT_STARTED_BUILD_READ_ONLY_RESULT_RECOVERY' and recovered['writes'] == 0
assert recovered['recoveredFromSha256'] == digest('database-empty-audit.json')
assert recovered['preparationSha256'] == started['preparationSha256'] == digest('database-empty-audit.json.preparation.json')
assert recovered['build']['id'] == original['build']['id'] == started['build']['id']
assert recovered['build']['status'] == 'SUCCEEDED'
assert recovered['build']['serviceRole'] == 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role'
assert recovered['sourceHash'] == original['sourceHash'] == prep['sourceHash']
assert recovered['buildspecHash'] == original['buildspecHash'] == prep['buildspecHash']
frame = recovered['result']
assert frame['gate'] == 'PASS' and frame['action'] == prep['plan']['action'] == 'audit-empty'
assert frame['prefix'] == prep['plan']['prefix'] and frame['buildId'] == original['build']['id'] and frame['sourceHash'] == prep['sourceHash']
assert frame['empty'] is True and not frame['devices'] and not frame['certificates'] and not frame['onboardingRequests']
assert frame['originalFingerprints'] == prep['plan']['baseline']
for n, expected in [('scripts/recover-qa09-db-result.mjs', recovered['recoverySourceHash'])]:
    b = subprocess.check_output(['git', 'show', sha + ':' + n])
    assert hashlib.sha256(b).hexdigest() == expected == hashlib.sha256(base64.b64decode(recovered['recoverySourceBase64'], validate=True)).hexdigest()
for source in recovered['dependencySources']:
    b = subprocess.check_output(['git', 'show', sha + ':scripts/' + source['name']])
    assert hashlib.sha256(b).hexdigest() == source['sha256'] == hashlib.sha256(base64.b64decode(source['sourceBase64'], validate=True)).hexdigest()
assert read('capacity-before-gate.json')['gate'] == 'PASS'
read('capacity-before.json'); read('actual-config.json')
for name, value in [('post-restoration-readonly.step.exit', '1'), ('audit-empty.readonly.exit', '1'), ('audit-result-recovery.step.exit', '0')]:
    assert (p / name).read_text().strip() == value; bindings[name] = digest(name)
for name in ['audit-empty.readonly.stderr.log', 'post-restoration-readonly.step.stderr.log']:
    bindings[name] = digest(name)
failures = [x for x in original['operations'] if x['result'] == 'FAIL']
assert len(failures) == 3 and all(x['operation'] == 'batch-get-builds' and x['failure']['code'] == original['failure']['code'] for x in failures)
assert sum(x['operation'] == 'start-build' for x in original['operations']) == 1
v = dict(gate='PASS', scope='RESTORED_DEFAULT_OFF_WITH_FRESH_READ_ONLY_CAPACITY_AND_EXACT_ORIGINAL_EMPTY_AUDIT_RESULT_RECOVERY', sourceCommit=sha, runId=restore['runId'], finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), newBusinessFixtures=0, newBusinessRequests=0, newAuditBuildOnRecovery=False, originalAuditClientGate='FAIL', originalAuditFailure=original['failure']['code'], originalFailedReadAttempts=len(failures), effectiveAuditGate='PASS', resultRecoveryProfile='esgiot-readonly', budgetScope='STATIC_AND_READ_ONLY_SNAPSHOT_NOT_NEW_LOAD', bindings=bindings, p95Accepted=False, fullQa09Accepted=False)
out.write_text(json.dumps(v, indent=2) + '\n'); print(json.dumps({k:x for k,x in v.items() if k != 'bindings'}))
