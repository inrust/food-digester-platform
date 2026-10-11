"""Validate evidence integrity and successful off restoration without promoting failed R1 stages."""
from pathlib import Path
import ast,base64,gzip,hashlib,json,re,subprocess
root=Path(__file__).resolve().parent;out=root/'final-checks/summary.json';assert not out.exists();sha='41ee358fb92e4dae2ae4abba7eb9923996fe029b'
counts=dict(files=0,pythonAst=0,nodeSyntax=0,decodedSources=0,gzipSources=0)
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
def scan(b):assert not any(x.search(b) for x in patterns),'CREDENTIAL_PATTERN_DETECTED'
def walk(v):
 if isinstance(v,dict):
  for k,x in v.items():
   if k=='sourceBase64' and isinstance(x,str):scan(base64.b64decode(x,validate=True));counts['decodedSources']+=1
   if k=='buildspec' and isinstance(x,str):
    for token in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}',x):
     b=base64.b64decode(token,validate=True);scan(b)
     if b.startswith(b'\x1f\x8b'):
      b=gzip.decompress(b);assert len(b)<2*1024*1024;scan(b);counts['gzipSources']+=1
   walk(x)
 elif isinstance(v,list):
  for x in v:walk(x)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(n):return json.loads((root/n).read_text())
def bound(n,base='',gate='PASS'):
 v=read(n);assert v['gate']==gate,n
 for f,h in v['bindings'].items():assert digest(root/base/f)==h,f
 return v
for p in sorted(root.rglob('*')):
 if not p.is_file():continue
 counts['files']+=1;b=p.read_bytes();scan(b)
 if p.suffix=='.py':ast.parse(b,filename=str(p));counts['pythonAst']+=1
 if p.suffix=='.mjs':subprocess.run(['node','--check',str(p)],check=True,capture_output=True);counts['nodeSyntax']+=1
 if p.suffix=='.json':walk(json.loads(b))
for n,h in read('preflight/entry-scope.json')['entryHelpers'].items():assert digest(root/n)==h,'ENTRY_HELPER_DRIFT:'+n
bound('preflight/entry-completion.json')
r0=bound('r0/unit-completion.json','r0');assert r0['businessChecks']==123 and r0['exactPhaseRequests']==55 and r0['negativeRequests']==12 and r0['cleanupRecovery'] is False
r1=bound('r1/cleanup-only-completion.json','r1');assert r1['stageGate']==r1['logReadRecoveryGate']=='FAIL' and r1['businessChecks']==123 and r1['cleanupRecovery'] is False and r1['independentEmptyAudit']=='PASS'
assert not (root/'r1/unit-completion.json').exists() and not (root/'r1/complete-unit.closure.exit').exists(),'NO_FULL_R1_STAGE_CLOSURE'
failed=bound('r1/log-read-failure-classification.json','r1',gate='FAIL');assert failed['remainingExactInvocations']==12 and failed['recoveryGate']=='FAIL' and failed['extraSamples']==failed['newBusinessRequests']==0
for mode in ['r0','r1']:
 for n in ['sample.json','sample.json.fixtures.json','sample.json.gate.json','database-empty-audit.json']:assert read(mode+'/'+n)['gate']=='PASS'
 v=bound(mode+'/artifact-transition.json');assert v['allCodeUnchanged'] and v['nonApiRevisionsUnchanged']
 metric=bound(mode+'/connection-budget-gate.json',mode);assert metric['observedMaximum']<=70 and metric['businessWindowSampleCoverage']
for n in ['baseline-patch.json','baseline-audit.json','sampling-audit.json']:assert read('r1/'+n)['gate']=='PASS'
for n in ['sampling-patch.json','sampling-patch-recovered.json']:
 v=read('r1/'+n);assert v['gate']=='PARTIAL' and v['logReadErrors']=={'lambda':'LOG_READ_TIMEOUT'} and v['exactLinkedCount']==0
negative=read('r1/negative-get.json');assert negative['gate']=='PASS' and len(negative['rows'])==12
baseline=bound('r1/available-baseline-description.json','r1',gate='DESCRIPTIVE_ONLY');assert baseline['requestCount']==43 and baseline['baselinePhaseGate']=='PASS' and baseline['fullR1StageGate']=='FAIL' and len(baseline['summaries'])==6
for x in baseline['summaries']:assert x['summary']['schemaVersion']==2 and x['summary']['status']=='COMPLETE'
t=bound('r1/transport-partial-observations.json','r1',gate='DESCRIPTIVE_ONLY');assert t['requestCount']==55 and t['unknownLambdaCount']==12 and t['additionalRequests']==0
bound('r0/transport-observations.json','r0');bound('r0/contract-window-observations.json','r0',gate='DESCRIPTIVE_ONLY')
restore=bound('restore/restore-completion.json','restore');assert restore['scope']=='SAME_SHA_RESTORE_DEFAULT_OFF_AFTER_R1_FAILED_LOG_STAGE_OWN_CLEANUP' and restore['newFixtures']==0
assert restore['predecessorClosureSha256']==digest(root/'r1/cleanup-only-completion.json')
artifact=bound('restore/deployment-input-binding.json','restore');assert artifact['originalArtifactDownloadGate']=='FAIL' and artifact['artifactReadRecovery']=='PASS'
assert restore['originalArtifactDownloadGate']=='FAIL' and restore['artifactReadRecovery']=='PASS'
assert int((root/'restore/bind-deployment.pipeline.exit').read_text())==1 and int((root/'restore/bind-deployment-recovered.pipeline.exit').read_text())==0
assert 'unexpected EOF' in (root/'restore/artifact-download.stderr.log').read_text() and int((root/'restore/artifact-download.exit').read_text())!=0 and int((root/'restore/artifact-download-recovered.exit').read_text())==0
bound('restore/post-restoration-readonly.json','restore');bound('restore/prestart-entry-gate.json','restore');bound('restore/artifact-transition.json')
domain=bound('restore/owned-domain-readonly.json');assert len(domain['observations'])==4 and all(v['versionsRemaining']==0 for v in domain['observations'])
assert read('restore/owned-build-terminal-bounded.json')['allMatchingOwnBuildsTerminal'] is True
comparison=bound('comparison.json',gate='PARTIAL');assert comparison['fullPhasePairGate']=='FAIL' and comparison['matchedNaturalColdGate']=='NOT_RUN'
assert comparison['businessPairGate']==comparison['cleanupPairGate']==comparison['restoreGate']=='PASS' and not comparison['p95Accepted'] and not comparison['fullQa09Accepted']
assert read('observer-observations.json')['reason']=='FULL_R1_STAGE_GATE_FAILED_LOG_READ_TIMEOUT'
live=read('final-live-readonly.json');assert live['gate']=='PASS' and len(live['runs'])==5
assert all(live['api'][k]=='false' for k in ['preconnect','accountReadCandidate','contractLoadDetail','contractPublicBoundaries','contractObserverCost'])
origins=read('preflight/r1-failed-stage-restore-helper-origins.json')
for row in origins['rows']:
 assert digest(root/row['source'])==row['sourceSha256'] and digest(root/row['adapted'])==row['adaptedSha256']
 source=(root/row['source']).read_text()
 for change in row['replacements']:source=source.replace(change['before'],change['after'])
 assert source==(root/row['adapted']).read_text()
matrix=read('preflight/failed-stage-restore-negative-matrix.json');assert matrix['gate']=='PASS' and matrix['tests']==12 and matrix['networkCalls']==matrix['cloudMutations']==0
for n,h in matrix['sourceHashes'].items():assert digest(root/n)==h
for row in read('preflight/restoration-artifact-read-recovery-origins.json')['rows']:
 assert digest(root/row['source'])==row['sourceSha256'] and digest(root/row['adapted'])==row['adaptedSha256']
 source=(root/row['source']).read_text()
 for change in row['replacements']:source=source.replace(change['before'],change['after'])
 assert source==(root/row['adapted']).read_text()
ci=read('preflight/ci-run.json');assert ci['headSha']==sha and ci['conclusion']=='success' and ci['attempt']==1
q=subprocess.run(['node','scripts/check-qa09-owned-summary.mjs','docs/audit/evidence/qa-09-owned-summary-2026-10-11'],capture_output=True,text=True);assert q.returncode==0 and json.loads(q.stdout)['gate']=='LOCAL_OWNED_SUMMARY_PASS'
historical=0
for directory in ['qa-09-5773ac9-r0-r1-2026-10-11','qa-09-owned-summary-2026-10-11']:
 p=root.parent/directory
 for n,h in json.loads((p/'manifest.json').read_text())['files'].items():assert digest(p/n)==h;historical+=1
q=subprocess.run(['git','diff',sha,'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],capture_output=True);assert q.returncode==0 and not q.stdout
subprocess.run(['git','diff','--check'],check=True)
v={'gate':'PASS','scope':'LOCAL_EVIDENCE_INTEGRITY_ONLY_WITH_FAILED_FULL_R1_STAGE_PRESERVED','sourceCommit':sha,'counts':counts,'secretPatternHits':0,'historicalFilesVerified':historical,'applicationSourceUnchanged':True,'r0StageGate':'PASS','r1StageGate':'FAIL','r1LogReadRecoveryGate':'FAIL','businessPairGate':'PASS','cleanupPairGate':'PASS','restoreGate':'PASS','originalArtifactDownloadGate':'FAIL','artifactReadRecovery':'PASS','matchedNaturalColdGate':'NOT_RUN','boundedSequenceGate':'PARTIAL','p95Accepted':False,'fullQa09Accepted':False}
out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(v,indent=2)+'\n');print(json.dumps(v))
