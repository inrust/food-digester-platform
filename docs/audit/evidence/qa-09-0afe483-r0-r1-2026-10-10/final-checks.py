"""Local completed-pair evidence validation only; never calls AWS or business APIs."""
from pathlib import Path
import ast, base64, gzip, hashlib, json, re, subprocess

root = Path(__file__).resolve().parent
sha = '0afe48384537c8c79ec6ce87276858120b9fd6ef'
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
        assert v['gate'] == 'PASS' and v['contractAwaitCheckpointRequired'] is True
restore = bound('restore/restore-completion.json', 'restore')
assert restore['sourceCommit'] == sha and restore['newFixtures'] == 0
bound('restore/post-restoration-readonly.json', 'restore')
bound('restore/prestart-entry-gate.json', 'restore')
domain = bound('restore/owned-domain-readonly.json', '')
assert len(domain['observations']) == 4 and all(v['versionsRemaining'] == 0 for v in domain['observations'])
assert read('restore/capacity-before-gate.json')['snapshotClientConnections'] <= 70
config = read('restore/actual-config.json')
assert config['gate'] == 'PASS' and all(config['config'][k] == 'false' for k in ['preconnect', 'accountReadCandidate', 'contractLoadDetail'])
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
hist_count = 0
for item in read('preflight/history-binding.json')['immutableManifests']:
    m = Path(item['manifest']); assert digest(m) == item['manifestSha256']
    for n, h in json.loads(m.read_text())['files'].items():
        assert digest(m.parent / n) == (h['sha256'] if isinstance(h, dict) else h); hist_count += 1
q = subprocess.run(['git', 'diff', sha, '--', 'apps', 'packages', 'contracts', 'infra', 'scripts', '.github', 'package.json', 'pnpm-lock.yaml'], capture_output=True)
assert q.returncode == 0 and not q.stdout, 'APPLICATION_SOURCE_DRIFT'
subprocess.run(['git', 'diff', '--check'], check=True)
result = dict(gate='PASS', scope='LOCAL_EVIDENCE_SYNTAX_CREDENTIAL_HYGIENE_IMMUTABLE_PAIR_AND_RESTORE_BINDINGS_ONLY', sourceCommit=sha, counts=counts, secretPatternHits=0, historicalFilesVerified=hist_count, applicationSourceUnchanged=True, originalR0Gate='PASS', originalR1Gate='PASS', restoreGate='PASS', knownBuildsTerminal='PASS', p95Accepted=False, fullQa09Accepted=False)
out.parent.mkdir(exist_ok=True); out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
