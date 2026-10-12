"""Local completed-pair evidence validation only; never calls AWS or business APIs."""
from pathlib import Path
import ast, base64, gzip, hashlib, json, re, subprocess

root = Path(__file__).resolve().parent
sha = 'ad213fa27375369fc0320f1747b1490a6292a41b'
out = root / 'final-checks/summary.json'
assert not out.exists()
patterns = [re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'), re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'), re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
counts = dict(files=0, pythonAst=0, nodeSyntax=0, decodedSources=0, gzipSources=0)
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def read(n): return json.loads((root / n).read_text())
def scan(b): assert not any(p.search(b) for p in patterns), 'CREDENTIAL_PATTERN_DETECTED'
def walk(v):
    if isinstance(v, dict):
        for k, x in v.items():
            if k == 'sourceBase64' and isinstance(x, str):
                scan(base64.b64decode(x, validate=True)); counts['decodedSources'] += 1
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
def bound(name, base):
    v = read(name); assert v['gate'] == 'PASS', name
    for n, h in v['bindings'].items(): assert digest(root / base / n) == h, n
    return v
for n, h in read('preflight/entry-scope.json')['entryHelpers'].items():
    assert digest(root / n) == h, 'ENTRY_HELPER_DRIFT:' + n
bound('preflight/entry-completion.json', '')
for mode in ['r0', 'r1']:
    unit = bound(mode + '/unit-completion.json', mode)
    assert unit['sourceCommit'] == sha and unit['originalExecutionGate'] == 'PASS'
    assert unit['businessChecks'] == 123 and unit['exactPhaseRequests'] == 55 and unit['negativeRequests'] == 12
    assert unit['cleanup'] == unit['independentEmptyAudit'] == 'PASS' and unit['cleanupRecovery'] is False
    for name in ['sample.json', 'sample.json.fixtures.json', 'sample.json.gate.json']:
        assert read(mode + '/' + name)['gate'] == 'PASS'
    bound(mode + '/prestart-entry-gate.json', mode)
    transport = bound(mode + '/transport-observations.json', mode)
    assert transport['requestCount'] == 55 and transport['additionalRequests'] == 0
    assert read(mode + '/connection-budget-gate.json')['observedMaximum'] <= 70
    for name in ['baseline-phases.json', 'sampling-phases.json']:
        v = read(mode + '/' + name)
        assert v['gate'] == 'PASS' and v['contractAwaitCheckpointRequired'] is True and v['contractPublicBoundariesRequired'] is True
restore = bound('restore/restore-completion.json', 'restore')
assert restore['sourceCommit'] == sha and restore['newFixtures'] == 0
bound('restore/post-restoration-readonly.json', 'restore')
bound('restore/prestart-entry-gate.json', 'restore')
domain = bound('restore/owned-domain-readonly.json', '')
assert len(domain['observations']) == 4 and all(v['versionsRemaining'] == 0 for v in domain['observations'])
assert read('restore/capacity-before-gate.json')['snapshotClientConnections'] <= 70
config = read('restore/actual-config.json')
assert config['gate'] == 'PASS' and all(config['config'][k] == 'false' for k in ['preconnect', 'accountReadCandidate', 'contractLoadDetail', 'contractPublicBoundaries', 'contractObserverCost'])
a, b = read('r1/application-version.json'), read('restore/application-version.json')
assert a['gate'] == b['gate'] == 'PASS' and a['sourceCommit'] == b['sourceCommit'] == sha and len(b['lambdaArtifacts']) == 19
prior = {x['name']: x for x in a['lambdaArtifacts']}
for x in b['lambdaArtifacts']:
    assert x['codeSha256'] == prior[x['name']]['codeSha256']
    if x['name'] != 'fdp-test-api': assert x['revisionId'] == prior[x['name']]['revisionId']
terminal = read('restore/owned-build-terminal-bounded.json')
assert terminal['gate'] == 'PASS' and terminal['allMatchingOwnBuildsTerminal'] is True
comparison = read('comparison.json'); assert comparison['gate'] == 'PARTIAL'
assert comparison['businessPairGate'] == comparison['cleanupPairGate'] == comparison['restoreGate'] == 'PASS'
assert comparison['causalBenefit'] == 'NOT_ESTABLISHED' and comparison['p95Accepted'] is False and comparison['fullQa09Accepted'] is False
for n, h in comparison['bindings'].items(): assert digest(root / n) == h
ci = read('preflight/ci-run.json')
assert ci['headSha'] == sha and ci['conclusion'] == 'success' and ci['attempt'] == 1
assert read('default-off/application-version.json')['gate'] == 'PASS'
for mode in ['r0', 'r1']:
    c = read(mode + '/actual-config.json')['config']
    assert c['accountReadCandidate'] == 'true' and c['contractObserverCost'] == str(mode == 'r1').lower()
    for group in ['baseline', 'sampling']:
        patch = read(mode + '/' + group + '-patch.json')
        assert patch['observerCostRequired'] == (mode == 'r1') and patch['observerCostRejected'] == 0 and patch['ownedBoundariesRequired'] == (mode == 'r1')
        if mode == 'r0': assert all(not row['contractObserverCost'] for row in patch['records'])
        else: assert read(mode + '/' + group + '-phases.json')['contractObserverCostRequired'] is True and read(mode + '/' + group + '-phases.json')['ownedBoundariesRequired'] is True
q = subprocess.run(['python3',str(root/'check-implementation-seal.py')], capture_output=True, text=True)
assert q.returncode == 0 and json.loads(q.stdout)['gate'] == 'LOCAL_UNKNOWN_START_BATCH_PASS'
implementation_count = 36
hist_count = json.loads(q.stdout)['sealedFiles']
for mode in ['r0', 'r1']:
    w = read(mode + '/contract-window-observations.json')
    assert w['gate'] == 'DESCRIPTIVE_ONLY' and w['additionalRequests'] == 0
    assert w['compilerOnlyAttribution'] is False and w['p95Accepted'] is False
    for name, h in w['bindings'].items(): assert digest(root / mode / name) == h
live = read('final-live-readonly.json')
assert live['gate'] == 'PASS' and len(live['runs']) == 5
assert comparison['matchedNaturalColdGate'] in ['INPUT_COMPATIBLE', 'NOT_OBSERVED']

q = subprocess.run(['git', 'diff', sha, '--', 'apps', 'packages', 'contracts', 'infra', 'scripts', '.github', 'package.json', 'pnpm-lock.yaml'], capture_output=True)
assert q.returncode == 0 and not q.stdout, 'APPLICATION_SOURCE_DRIFT'
subprocess.run(['git', 'diff', '--check'], check=True)
result = dict(gate='PASS', scope='LOCAL_EVIDENCE_SYNTAX_CREDENTIAL_HYGIENE_IMMUTABLE_PAIR_AND_RESTORE_BINDINGS_ONLY', sourceCommit=sha, counts=counts, secretPatternHits=0, historicalFilesVerified=hist_count, implementationFilesVerified=implementation_count, applicationSourceUnchanged=True, originalR0Gate='PASS', originalR1Gate='PASS', restoreGate='PASS', knownBuildsTerminal='PASS', p95Accepted=False, fullQa09Accepted=False)
out.parent.mkdir(exist_ok=True); out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
