"""Local immutable evidence checks only; no AWS mutation or network probes."""
from pathlib import Path
import ast,base64,gzip,hashlib,json,re,subprocess
root=Path(__file__).parent;out=root/'final-checks';out.mkdir(exist_ok=True);assert not (out/'summary.json').exists()
sha='b5522378aebca9340a0767b53ed3bab846ffc080';patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
counts={'files':0,'pythonAst':0,'nodeSyntax':0,'decodedSources':0,'gzipSources':0}
def scan(data):assert not any(p.search(data) for p in patterns),'CREDENTIAL_PATTERN_DETECTED'
def walk(v):
 if isinstance(v,dict):
  for k,x in v.items():
   if k=='sourceBase64' and isinstance(x,str):
    b=base64.b64decode(x,validate=True);scan(b);counts['decodedSources']+=1
   if k=='buildspec' and isinstance(x,str):
    for t in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}',x):
     b=base64.b64decode(t,validate=True);scan(b)
     if b.startswith(b'\x1f\x8b'):
      b=gzip.decompress(b);assert len(b)<2*1024*1024;scan(b);counts['gzipSources']+=1
   walk(x)
 elif isinstance(v,list):
  for x in v:walk(x)
for p in root.rglob('*'):
 if not p.is_file():continue
 counts['files']+=1;b=p.read_bytes();scan(b)
 if p.suffix=='.py':ast.parse(b,filename=str(p));counts['pythonAst']+=1
 if p.suffix=='.mjs':
  q=subprocess.run(['node','--check',str(p)],capture_output=True);assert q.returncode==0,str(p);counts['nodeSyntax']+=1
 if p.suffix=='.json':walk(json.loads(b))
def read(n):return json.loads((root/n).read_text())
for mode,name in [('r0','cleanup-only-completion.json'),('r0','cleanup-recovery-completion.json'),('r0','runtime-final-binding.json'),('restore','restore-completion.json'),('restore','post-restoration-readonly.json')]:
 v=read(mode+'/'+name);assert v['gate']=='PASS'
 for n,h in v['bindings'].items():assert hashlib.sha256((root/mode/n).read_bytes()).hexdigest()==h,'CLOSURE_BYTES_DRIFT:'+n
for n,h in read('preflight/entry-scope.json')['entryHelpers'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==h,'ENTRY_HELPER_DRIFT:'+n
parent,child,wrapper=read('r0/sample.json.fixtures.json'),read('r0/sample.json'),read('r0/sample.json.gate.json')
assert parent['gate']==wrapper['gate']=='FAIL' and child['gate']=='PASS' and len(child['checks'])==123 and child['cleanupComplete']
for n in ['dispatch.exit','dispatch-run.json','sample.json','unit-completion.json','business-window.json']:assert not (root/'r1'/n).exists(),'R1_MUST_NOT_HAVE_RUN'
for n in ['baseline-phases.json','sampling-phases.json']:
 v=read('r0/'+n);assert v['gate']=='PASS' and v['contractAwaitCheckpointRequired'] is True
assert read('r0/negative-gate.json')['gate']=='PASS'
assert read('r0/connection-budget-gate.json')['observedMaximum']<=70
assert read('restore/capacity-before-gate.json')['snapshotClientConnections']<=70
config=read('restore/actual-config.json');assert config['gate']=='PASS'
assert all(config['config'][k]=='false' for k in ['preconnect','accountReadCandidate','contractLoadDetail'])
a,b=read('r0/application-version.json'),read('restore/application-version.json');assert a['gate']==b['gate']=='PASS' and a['sourceCommit']==b['sourceCommit']==sha and len(b['lambdaArtifacts'])==19
prior={x['name']:x for x in a['lambdaArtifacts']}
for x in b['lambdaArtifacts']:
 assert x['codeSha256']==prior[x['name']]['codeSha256']
 if x['name']!='fdp-test-api':assert x['revisionId']==prior[x['name']]['revisionId']
domain=read('restore/owned-domain-readonly.json');assert domain['gate']=='PASS' and len(domain['observations'])==2 and all(x['versionsRemaining']==0 for x in domain['observations'])
for n,h in domain['bindings'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==h
terminal=read('restore/owned-build-terminal-bounded.json');assert terminal['gate']=='PASS' and terminal['allMatchingOwnBuildsTerminal'] is True
assert all(x['status'] in ['SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT'] for x in terminal['ownBuilds'])
history=read('preflight/history-binding.json');histCount=0
for item in history['immutableManifests']:
 m=Path(item['manifest']);assert hashlib.sha256(m.read_bytes()).hexdigest()==item['manifestSha256'];v=json.loads(m.read_text())
 for n,h in v['files'].items():
  if isinstance(h,dict):h=h['sha256']
  assert hashlib.sha256((m.parent/n).read_bytes()).hexdigest()==h;histCount+=1
q=subprocess.run(['git','diff',sha,'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],capture_output=True);assert q.returncode==0 and not q.stdout,'APPLICATION_SOURCE_DRIFT'
q=subprocess.run(['git','diff','--check'],capture_output=True);assert q.returncode==0,'TRACKED_DIFF_CHECK'
result={'gate':'PASS','scope':'LOCAL_EVIDENCE_SYNTAX_CREDENTIAL_HYGIENE_IMMUTABLE_CLEANUP_RESTORE_BINDINGS_ONLY','sourceCommit':sha,'counts':counts,'secretPatternHits':0,'historicalFilesVerified':histCount,'applicationSourceUnchanged':True,'originalR0Gate':'FAIL','r1Gate':'NOT_RUN','compensatingCleanupGate':'PASS','restoreGate':'PASS','knownBuildsTerminal':'PASS','p95Accepted':False,'fullQa09Accepted':False}
(out/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
