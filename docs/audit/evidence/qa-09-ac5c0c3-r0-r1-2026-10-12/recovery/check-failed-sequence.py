"""Local failed-unit/cleanup/restore validation; never upgrades the original unit."""
from pathlib import Path
import ast, base64, gzip, hashlib, json, re, subprocess

root = Path(__file__).resolve().parent.parent
sha = 'ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2'
out = root / 'final-checks/failure-summary.json'
assert not out.exists()
bindings = {}
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def read(n):
    p = root / n
    bindings[n] = digest(p)
    return json.loads(p.read_text())
def bound(n, base=''):
    v = read(n)
    assert v['gate'] == 'PASS', n
    for name, value in v['bindings'].items():
        assert digest(root / base / name) == value, name
    return v

for name, value in read('preflight/entry-scope.json')['entryHelpers'].items():
    assert digest(root / name) == value, name
bound('preflight/entry-completion.json')
closure = bound('r0/cleanup-only-completion.json', 'r0')
assert closure['sourceCommit'] == sha and closure['originalExecutionGate'] == closure['stageGate'] == 'FAIL'
assert closure['cleanup'] == closure['independentEmptyAudit'] == 'PASS'
assert closure['unknownBusinessAuditStart'] == 'UNKNOWN' and closure['compensatingCleanupWrites'] == closure['businessReplays'] == 0
child, parent, wrapper = [read('r0/' + n) for n in ['sample.json', 'sample.json.fixtures.json', 'sample.json.gate.json']]
assert child['gate'] == parent['gate'] == wrapper['gate'] == 'FAIL'
assert child['cleanupComplete'] is False and len(child['checks']) == 116
assert all(x['result'] == 'PASS' for x in child['checks'])
assert all(x['result'] == 'PASS' for x in parent['cleanup'])
assert len([x for x in child['cleanup'] if x['type'] == 'cognito']) == 4
assert all(x['globalSignOut'] == x['deletion'] == x['absence'] == x['result'] == 'PASS' for x in child['cleanup'] if x['type'] == 'cognito')
for n in ['r1/dispatch.exit', 'r1/sample.json', 'r0/unit-completion.json', 'comparison.json']:
    assert not (root / n).exists(), n
unknown = read('r0/sample.json.business-audit-2.json')
assert unknown['gate'] == 'FAIL' and not unknown.get('build') and unknown['failure']['kind'] == 'START_OUTCOME_UNCONFIRMED'
narrow = read('r0/business-audit-unknown-recent-five.json')
assert narrow['gate'] == 'UNKNOWN' and narrow['exactMatches'] == 0 and narrow['windowCovered'] is True
assert narrow['writes'] == 0 and narrow['restartAllowed'] is False and narrow['absenceProvesNonExecution'] is False
cloudtrail = read('recovery/unknown-start-cloudtrail.json')
assert cloudtrail['writes'] == 0 and cloudtrail['absenceProvesNonExecution'] is False
observed = read('recovery/r0-existing-observations.json')
assert observed['gate'] == 'PARTIAL' and observed['exactPhaseRequests'] == 55 and observed['additionalRequests'] == 0
assert observed['baselinePhaseGate'] == 'PASS' and observed['samplingFinalPhaseGate'] == 'BLOCKED'
for n, value in observed['bindings'].items(): assert digest(root / 'r0' / n) == value, n
assert 'COLD_SAMPLING_FINAL_CHILD_REQUIRED' in (root / 'recovery/r0-sampling-phases.stderr.log').read_text()
budget = read('r0/connection-budget-gate.json')
assert budget['gate'] == 'PASS' and budget['observedMaximum'] <= 70 and budget['businessWindowSampleCoverage']
restored = bound('restore/restore-completion.json', 'restore')
assert restored['sourceCommit'] == sha and 'R0_FAILED_STAGE' in restored['scope'] and restored['newFixtures'] == 0
wait = read('restore/wait-read-recovery-binding.json')
assert wait['originalWaitGate'] == 'FAIL' and wait['runId'] == restored['runId']
assert wait['newDispatches'] == wait['newBusinessRequests'] == 0
for n, value in wait['bindings'].items(): assert digest(root / 'restore' / n) == value, n
assert digest(root / 'run-restore.py') == wait['sourceSha256']
assert digest(root / 'run-restore-read-recovery.py') == wait['derivedSha256']
assert (root / 'restore/wait-success-read-recovery.pipeline.exit').read_text().strip() == '0'
bound('restore/post-restoration-readonly.json', 'restore')
bound('restore/prestart-entry-gate.json', 'restore')
domain = bound('restore/owned-domain-readonly.json')
assert len(domain['observations']) == 2 and all(x['versionsRemaining'] == 0 for x in domain['observations'])
for n in ['r0/artifact-transition.json', 'restore/artifact-transition.json']: bound(n)
config = read('restore/actual-config.json')
assert config['gate'] == 'PASS' and all(config['config'][k] == 'false' for k in ['preconnect', 'accountReadCandidate', 'contractLoadDetail', 'contractPublicBoundaries', 'contractObserverCost'])
before, after = [read(n + '/application-version.json') for n in ['r0', 'restore']]
assert before['gate'] == after['gate'] == 'PASS' and before['sourceCommit'] == after['sourceCommit'] == sha
assert len(before['lambdaArtifacts']) == len(after['lambdaArtifacts']) == 19
prior = {x['name']: x for x in before['lambdaArtifacts']}
for item in after['lambdaArtifacts']:
    assert item['codeSha256'] == prior[item['name']]['codeSha256']
    if item['name'] != 'fdp-test-api': assert item['revisionId'] == prior[item['name']]['revisionId']
terminal = read('restore/owned-build-terminal-bounded.json')
assert terminal['gate'] == 'PASS' and terminal['allMatchingOwnBuildsTerminal'] and terminal['fullOriginalRunWindowCovered']
assert terminal['originalUnknownStartResolved'] is False
final_unknown = read('restore/unknown-start-final-status.json')
assert final_unknown['gate'] == 'PARTIAL' and final_unknown['finalStartGate'] == 'UNKNOWN'
assert final_unknown['originalStartResolved'] is False and final_unknown['absenceProvesNonExecution'] is False
assert final_unknown['restarts'] == final_unknown['writes'] == 0
for n, value in final_unknown['bindings'].items(): assert digest(root / n) == value, n
assert read('final-live-readonly.json')['gate'] == 'PASS' and len(read('final-live-readonly.json')['runs']) == 4
ci = read('preflight/ci-run.json')
assert ci['headSha'] == sha and ci['attempt'] == 1 and ci['conclusion'] == 'success'
q = subprocess.run(['python3', str(root / 'check-implementation-seal.py')], capture_output=True, text=True)
assert q.returncode == 0 and json.loads(q.stdout)['gate'] == 'LOCAL_PUBLIC_WINDOW_PARENT_PASS'
q = subprocess.run(['git', 'diff', sha, '--', 'apps', 'packages', 'contracts', 'infra', 'scripts', '.github', 'package.json', 'pnpm-lock.yaml'], capture_output=True)
assert q.returncode == 0 and not q.stdout, 'APPLICATION_SOURCE_DRIFT'

patterns = [re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'), re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'), re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
counts = dict(files=0, pythonAst=0, nodeSyntax=0, decodedSources=0, gzipSources=0)
def scan(b): assert not any(x.search(b) for x in patterns), 'CREDENTIAL_PATTERN_DETECTED'
def walk(v):
    if isinstance(v, dict):
        for k, x in v.items():
            if k == 'sourceBase64' and isinstance(x, str): scan(base64.b64decode(x, validate=True)); counts['decodedSources'] += 1
            if k == 'buildspec' and isinstance(x, str):
                for token in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}', x):
                    b = base64.b64decode(token, validate=True); scan(b)
                    if b.startswith(b'\x1f\x8b'):
                        b = gzip.decompress(b); assert len(b) < 2 * 1024 * 1024
                        scan(b); counts['gzipSources'] += 1
            walk(x)
    elif isinstance(v, list):
        for x in v: walk(x)
for p in sorted(root.rglob('*')):
    if not p.is_file(): continue
    counts['files'] += 1; b = p.read_bytes(); scan(b)
    if p.suffix == '.py': ast.parse(b, filename=str(p)); counts['pythonAst'] += 1
    if p.suffix == '.mjs':
        q = subprocess.run(['node', '--check', str(p)], capture_output=True)
        assert q.returncode == 0, str(p)
        counts['nodeSyntax'] += 1
    if p.suffix == '.json': walk(json.loads(b))
result = dict(gate='PASS', scope='LOCAL_FAILED_R0_RESIDUAL_CLEANUP_AND_DEFAULT_OFF_RESTORE_EVIDENCE_ONLY', sourceCommit=sha, counts=counts, secretPatternHits=0, historicalFilesVerified=1210, applicationSourceUnchanged=True, originalR0Gate='FAIL', r1Gate='NOT_RUN', residualCleanupGate='PASS', restoreGate='PASS', unknownReadOnlyStart='UNKNOWN', businessReplays=0, p95Accepted=False, fullQa09Accepted=False, bindings=bindings)
out.parent.mkdir(exist_ok=True); out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'bindings'}))
