"""Offline validation of failed R0, original cleanup and restored defaults; no cloud calls."""
from pathlib import Path
import ast, base64, gzip, hashlib, json, re, subprocess, sys
root = Path(__file__).resolve().parent
repo = root.parents[3]
sha = 'ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'
def read(name): return json.loads((root / name).read_bytes())
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def bound(name, base=''):
    v = read(name)
    assert v['gate'] == 'PASS', name
    for n, h in v.get('bindings', {}).items():
        assert digest(root / base / n) == h, name + ':' + n
    return v
for n, h in read('preflight/entry-scope.json')['entryHelpers'].items():
    assert digest(root / n) == h, 'FROZEN_HELPER_DRIFT:' + n
bound('preflight/entry-completion.json')
q = subprocess.run(['python3', str(root/'check-implementation-seal.py')], capture_output=True, text=True, cwd=repo)
assert q.returncode == 0, q.stderr
history = json.loads(q.stdout)
assert history['sealedFiles'] == 160 and history['sourceBindings'] == 14
c = bound('r0/cleanup-only-completion.json', 'r0')
assert c['sourceCommit'] == sha and c['stageGate'] == 'FAIL' and c['logCollectionGate'] == 'PARTIAL'
assert c['businessChecks'] == 123 and c['cleanupRecovery'] is False and c['mainPhaseRequests'] == 55
assert c['cleanup'] == c['independentEmptyAudit'] == 'PASS' and c['error'] == 'LOG_CALL_LIMIT'
assert c['businessReplays'] == c['extraSamples'] == 0 and c['r1Gate'] == 'NOT_RUN'
for name in ['sample.json','sample.json.fixtures.json','sample.json.gate.json','database-empty-audit.json','negative-get.json']:
    assert read('r0/'+name)['gate'] == 'PASS'
for name in ['finish-unit.pipeline.exit','collect-initial.closure.exit','collect-initial-recovery.closure.exit','local-import-recovery.exit']:
    assert (root/'r0'/name).read_text().strip() == '1'
assert 'ModuleNotFoundError' in (root/'r0/collect-initial.closure.stderr.log').read_text()
p = read('r0/initial-phases.json'); b = p['logReadBudget']
assert p['gate'] == 'PARTIAL' and len(p['records']) == 6 and b['error'] == 'LOG_CALL_LIMIT'
assert len(b['attempts']) == b['maxCalls'] == 40 and b['elapsedMs'] == 73013 and b['totalDeadlineMs'] == 120000
assert not (root/'r1/dispatch-run.json').exists() and not (root/'r1/sample.json').exists()
assert not (root/'r0/unit-completion.json').exists() and not (root/'r1/unit-completion.json').exists()
linked = 0
for name, count in [('baseline-patch',6),('baseline-audit',19),('sampling-patch',12),('sampling-audit',18)]:
    v = read('r0/'+name+'.json')
    assert v['gate'] == 'PASS' and v['sourceCommit'] == sha and v['prefix'] == c['prefix']
    assert len(v['records']) == v['exactLinkedCount'] == count and not v['logReadErrors']
    assert all(row['exactLinked'] for row in v['records'])
    assert not v['logReadBudget']['error'] and len(v['logReadBudget']['attempts']) <= 40
    assert (root/'r0'/(name+'-budget.exit')).read_text().strip() == '0'
    linked += count
for group in ['baseline','sampling']:
    v = read('r0/diagnostic-'+group+'-phases.json')
    assert v['gate'] == 'PASS' and v['sourceCommit'] == sha
    assert all(v[k] is True for k in ['clientSplitRequired','contractLoadDetailRequired','contractAwaitCheckpointRequired','contractPublicBoundariesRequired','engineCpuRequired','runtimeAssemblyRequired'])
restore = bound('restore/restore-completion.json','restore')
assert restore['sourceCommit'] == sha and restore['newFixtures'] == 0
assert restore['predecessorClosureSha256'] == digest(root/'r0/cleanup-only-completion.json')
bound('restore/post-restoration-readonly.json','restore')
bound('restore/prestart-entry-gate.json','restore')
a, z = read('r0/application-version.json'), read('restore/application-version.json')
assert a['gate'] == z['gate'] == 'PASS' and a['sourceCommit'] == z['sourceCommit'] == sha
old = {v['name']:v for v in a['lambdaArtifacts']}
new = {v['name']:v for v in z['lambdaArtifacts']}
assert len(new) == 19 and set(old) == set(new)
for name, v in new.items():
    assert all(v[k] == old[name][k] for k in ['codeSha256','artifactSha256','s3Bucket','s3Key','runtime'])
    if name != 'fdp-test-api': assert v['revisionId'] == old[name]['revisionId']
config = read('restore/actual-config.json'); cfg = config['config']
assert config['gate'] == 'PASS' and cfg['revisionId'] == new['fdp-test-api']['revisionId']
assert all(cfg[k] == 'false' for k in ['preconnect','accountReadCandidate','contractLoadDetail','contractPublicBoundaries','contractObserverCost'])
assert cfg['engineCpu'] == 'true' and cfg['pool'] == '1' and cfg['memory'] == 512 and config['concurrency']['ReservedConcurrentExecutions'] == 12
cap = read('restore/capacity-before-gate.json')
assert cap['gate'] == 'PASS' and cap['usableConnections'] == 70 and cap['staticConnectionBudget'] == 63 and cap['snapshotClientConnections'] <= 70
empty = read('restore/database-empty-audit.json')
assert empty['gate'] == 'PASS' and empty['result']['empty'] is True and empty['result']['prefix'] == c['prefix']
assert empty['result']['originalFingerprints'] == read('r0/database-empty-audit.json')['result']['originalFingerprints']
domain = bound('restore/owned-domain-readonly.json')
assert domain['prefixes'] == [c['prefix']] and len(domain['observations']) == 2
assert all(v['versionsRemaining'] == 0 for v in domain['observations'])
terminal = read('restore/owned-build-terminal-bounded.json')
assert terminal['gate'] == 'PASS' and terminal['knownBuildCount'] == 12 and len(terminal['ownBuilds']) == 12
assert terminal['allMatchingOwnBuildsTerminal'] is True and all(v['status'] == 'SUCCEEDED' for v in terminal['ownBuilds'])
live = read('final-live-readonly.json')
assert live['gate'] == 'PASS' and len(live['runs']) == 4 and live['api']['revisionId'] == cfg['revisionId']
assert all(v['headSha'] == sha and v['status'] == 'completed' and v['conclusion'] == 'success' for v in live['runs'])
assert next(v for v in live['runs'] if str(v['databaseId'])=='38184960835')['attempt'] == 2
q = subprocess.run(['git','diff',sha,'--','apps','packages','contracts','infra','.github','package.json','pnpm-lock.yaml'],cwd=repo,capture_output=True)
assert q.returncode == 0 and not q.stdout, 'APPLICATION_SOURCE_DRIFT'
allowed = {'scripts/'+p for p in ['collect-qa09-auxiliary-phases.py','check-qa09-auxiliary-read.mjs','qa09_auxiliary_read_test_driver.py','qa09-auxiliary-read.test.mjs','check-qa09-auxiliary-read.test.mjs']}
changed = subprocess.check_output(['git','diff','--name-only',sha,'--','scripts'],cwd=repo,text=True).splitlines()
assert set(changed).issubset(allowed), 'OLD_QA_SCRIPT_DRIFT'
patterns = [re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
counts = dict(files=0,pythonAst=0,nodeSyntax=0,decodedSources=0,gzipSources=0)
def scan(b): assert not any(p.search(b) for p in patterns), 'CREDENTIAL_PATTERN_DETECTED'
def walk(v):
    if isinstance(v,dict):
        for k,x in v.items():
            if k == 'sourceBase64' and isinstance(x,str):
                scan(base64.b64decode(x,validate=True));counts['decodedSources'] += 1
            if k == 'buildspec' and isinstance(x,str):
                for token in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}',x):
                    b = base64.b64decode(token,validate=True);scan(b)
                    if b.startswith(b'\x1f\x8b'):
                        b = gzip.decompress(b);assert len(b)<2*1024*1024;scan(b);counts['gzipSources']+=1
            walk(x)
    elif isinstance(v,list):
        for x in v:walk(x)
for p in sorted(root.rglob('*')):
    if not p.is_file():continue
    counts['files'] += 1;b=p.read_bytes();scan(b)
    if p.suffix == '.py':ast.parse(b,filename=str(p));counts['pythonAst']+=1
    if p.suffix == '.mjs':
        q=subprocess.run(['node','--check',str(p)],capture_output=True);assert q.returncode==0,str(p);counts['nodeSyntax']+=1
    if p.suffix == '.json':walk(json.loads(b))
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
result = dict(gate='PASS',scope='OFFLINE_FAILED_R0_EVIDENCE_ORIGINAL_CLEANUP_AND_RESTORED_DEFAULTS_ONLY',sourceCommit=sha,counts=counts,secretPatternHits=0,historicalFilesVerified=160,frozenEntryHelpers=len(read('preflight/entry-scope.json')['entryHelpers']),r0BusinessChecks=123,mainLinkedRequests=linked,r0StageGate='FAIL',r0AuxiliaryGate='PARTIAL',r1Gate='NOT_RUN',restoreGate='PASS',finalEmptyGate='PASS',knownBuilds=12,allKnownBuildsSucceeded=True,newLocalQaFilesAllowed=5,newLocalQaTargetAcceptance=False,causalBenefit='NOT_ESTABLISHED',p95Accepted=False,fullQa09Accepted=False)
if '--write' in sys.argv:
    with (root/'failed-stage-closure.json').open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
