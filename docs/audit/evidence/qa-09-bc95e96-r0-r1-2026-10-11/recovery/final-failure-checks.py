"""Validate failed R0 and verified residual cleanup/restore locally, never a completed pair."""
from pathlib import Path
import ast, base64, gzip, hashlib, json, re, subprocess

root = Path(__file__).resolve().parent.parent
sha = 'bc95e9671a0bfb69effa95ad7c315b375199f132'
out = root / 'final-checks/failure-summary.json'
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
for n,h in read('preflight/entry-scope.json')['entryHelpers'].items():assert digest(root/n)==h,n
bound('preflight/entry-completion.json','')
closure=bound('r0/cleanup-only-completion.json','r0')
assert closure['originalExecutionGate']=='FAIL' and closure['stageGate']=='FAIL' and closure['cleanup']=='PASS' and closure['unknownBusinessAuditStart']=='UNKNOWN'
child=read('r0/sample.json');parent=read('r0/sample.json.fixtures.json');wrapper=read('r0/sample.json.gate.json')
assert child['gate']==parent['gate']==wrapper['gate']=='FAIL' and child['cleanupComplete'] is False
assert len(child['checks'])==116 and all(x['result']=='PASS' for x in child['checks'])
assert not (root/'r1/dispatch.exit').exists() and not (root/'r1/sample.json').exists() and not (root/'r0/unit-completion.json').exists()
unknown=read('r0/sample.json.business-audit-2.json');assert unknown['gate']=='FAIL' and not unknown.get('build') and unknown['failure']['kind']=='START_OUTCOME_UNCONFIRMED'
assert read('recovery/unknown-audit-binding-diagnostic.json')['exactPlanMatches']==0
assert read('recovery/unknown-start-cloudtrail.json')['absenceProvesNonExecution'] is False
late=read('recovery/unknown-start-cloudtrail-final.json');assert late['gate']=='NOT_OBSERVED' and late['matches']==[] and late['absenceProvesNonExecution'] is False and late['writes']==0
observed=read('recovery/r0-existing-observations.json');assert observed['gate']=='PARTIAL' and observed['exactPhaseRequests']==55 and observed['samplingFinalPhaseGate']=='BLOCKED' and observed['additionalRequests']==0
for n,h in observed['bindings'].items():assert digest(root/'r0'/n)==h,n
assert 'COLD_SAMPLING_FINAL_CHILD_REQUIRED' in (root/'recovery/r0-sampling-phases.stderr.log').read_text()
assert read('r0/connection-budget-gate.json')['gate']=='PASS' and read('r0/connection-budget-gate.json')['observedMaximum']<=70
restore=bound('restore/restore-completion.json','restore');assert restore['sourceCommit']==sha and 'R0_FAILED_STAGE' in restore['scope'] and restore['newFixtures']==0
post=read('restore/post-restoration-readonly.json');assert post['gate']=='PARTIAL' and post['finalCapacityGate']=='UNKNOWN' and post['finalEmptyGate']=='PASS'
for n,h in post['bindings'].items():assert digest(root/'restore'/n)==h,n
for n,h in post['diagnosticBindings'].items():assert digest(root/n)==h,n
bound('restore/audit-empty-prestart-gate.json','restore')
cap=read('restore/capacity-before.json');assert cap['gate']=='FAIL' and cap['failure']['kind']=='START_OUTCOME_UNCONFIRMED' and not cap.get('build')
assert read('recovery/unknown-restored-capacity-cloudtrail.json')['absenceProvesNonExecution'] is False
domain=bound('restore/owned-domain-readonly.json','');assert len(domain['observations'])==2 and all(v['versionsRemaining']==0 for v in domain['observations'])
for n in ['r0/artifact-transition.json','restore/artifact-transition.json']:bound(n,'')
config=read('restore/actual-config.json');assert config['gate']=='PASS' and all(config['config'][k]=='false' for k in ['preconnect','accountReadCandidate','contractLoadDetail','contractPublicBoundaries','contractObserverCost'])
a,b=read('r0/application-version.json'),read('restore/application-version.json');assert a['gate']==b['gate']=='PASS' and len(a['lambdaArtifacts'])==len(b['lambdaArtifacts'])==19
old={x['name']:x for x in a['lambdaArtifacts']}
for x in b['lambdaArtifacts']:
 assert x['codeSha256']==old[x['name']]['codeSha256']
 if x['name']!='fdp-test-api':assert x['revisionId']==old[x['name']]['revisionId']
terminal=read('restore/owned-build-terminal-bounded.json');assert terminal['gate']=='PASS' and terminal['allMatchingOwnBuildsTerminal'] is True and terminal['originalUnknownStartResolved'] is False
unknowns=read('restore/unknown-starts-final-status.json');assert unknowns['gate']=='PARTIAL' and len(unknowns['unknownStarts'])==2 and unknowns['originalStartsResolved'] is False
for n,h in unknowns['bindings'].items():assert digest(root/n)==h,n
assert all(v['finalGate']=='UNKNOWN' and v['restarts']==0 and v['absenceProvesNonExecution'] is False for v in unknowns['unknownStarts'])
assert not (root/'restore/capacity-before-gate.json').exists() and not (root/'restore/prestart-entry-gate.json').exists()
assert read('final-live-readonly.json')['gate']=='PASS' and len(read('final-live-readonly.json')['runs'])==4
assert read('document-check.json')['gate']=='PASS' and read('document-check.json')['historicalTaskListUnchanged'] is True
ci=read('preflight/ci-run.json');assert ci['headSha']==sha and ci['conclusion']=='success' and ci['attempt']==2
q=subprocess.run(['node','scripts/check-qa09-observer-implementation.mjs','--check','docs/audit/evidence/qa-09-observer-cost-implementation-2026-10-11'],capture_output=True,text=True)
assert q.returncode==0 and json.loads(q.stdout)['gate']=='LOCAL_IMPLEMENTATION_PASS'
implementation=json.loads(q.stdout)
q=subprocess.run(['git','diff',sha,'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],capture_output=True);assert q.returncode==0 and not q.stdout
subprocess.run(['git','diff','--check'],check=True)
result=dict(gate='PASS',scope='LOCAL_FAILED_R0_RESIDUAL_CLEANUP_AND_DEFAULT_OFF_RESTORE_EVIDENCE_ONLY',sourceCommit=sha,counts=counts,secretPatternHits=0,historicalFilesVerified=implementation['previousSealedFiles'],applicationSourceUnchanged=True,originalR0Gate='FAIL',r1Gate='NOT_RUN',residualCleanupGate='PASS',restoreGate='PASS',restorePostReadOnlyGate='PARTIAL',unknownReadOnlyStart='UNKNOWN',finalCapacityStart='UNKNOWN',p95Accepted=False,fullQa09Accepted=False)
out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
