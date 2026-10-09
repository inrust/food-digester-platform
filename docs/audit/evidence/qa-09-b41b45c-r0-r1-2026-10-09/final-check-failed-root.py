"""Validate the failed-R0 cleanup/restore path without admitting R1 or rewriting originals."""
import ast,base64,datetime,gzip,hashlib,json,re,subprocess
from pathlib import Path
root=Path(__file__).parent;sha='b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e';out=root/'final-checks';out.mkdir(exist_ok=True)
assert not (out/'summary.json').exists()
def receipt(path):return json.loads((root/path).read_text())
for mode,name in [('r0','cleanup-only-completion.json'),('restore','restore-completion.json'),('restore','post-restoration-readonly.json')]:
 v=receipt(mode+'/'+name);assert v['gate']=='PASS' and v['sourceCommit']==sha
 for n,h in v['bindings'].items():
  f=(root/mode/n).resolve();assert f.is_relative_to(root.resolve())
  assert hashlib.sha256(f.read_bytes()).hexdigest()==h,'BOUND_RECEIPT_DRIFT'
invalid=receipt('restore/build-inventory-invalidation.json');assert invalid['gate']=='INVALID' and invalid['receiptSha256']==hashlib.sha256((root/'restore/owned-build-terminal.json').read_bytes()).hexdigest()
original=receipt('r0/sample.json');parent=receipt('r0/sample.json.fixtures.json');recovery=receipt('r0/cleanup-recovery-completion.json');restore=receipt('restore/restore-completion.json')
assert original['gate']==parent['gate']=='FAIL' and len(original['checks'])==115 and all(c['result']=='PASS' for c in original['checks'])
assert original['cold409Sampling']['gate']=='PASS' and len(original['cold409Sampling']['attempts'])==12
assert receipt('r0/cleanup-only-completion.json')['stageGate']=='FAIL' and recovery['gate']=='PASS'
assert restore['accountReadCandidate'] is False and restore['authenticatedPreconnect'] is False and restore['contractLoadDetail'] is False and restore['engineCpu'] is True
assert receipt('restore/owned-domain-readonly.json')['gate']=='PASS' and all(o['versionsRemaining']==0 for o in receipt('restore/owned-domain-readonly.json')['observations'])
assert receipt('restore/owned-build-terminal-bounded.json')['gate']=='PASS'
assert not (root/'r1/dispatch.exit').exists() and not (root/'r1/sample.json').exists()
assert receipt('r0/negative-gate.json')['gate']=='PASS' and len(receipt('r0/negative-gate.json')['rows'])==12
obs=receipt('r0/r0-observations.json');assert obs['gate']=='OBSERVATIONS_ONLY' and obs['requestCount']==55 and obs['patchDetailCount']==18 and obs['baselinePhysicalCold409']==1 and obs['matchingR1']=='NOT_RUN'
assert receipt('r0/baseline-phases.json')['contractLoadDetailRequired'] is True
assert 'COLD_SAMPLING_FINAL_CHILD_REQUIRED' in (root/'r0/sampling-phases.stderr.log').read_text()
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
files=sorted(p for p in root.rglob('*') if p.is_file());py=node=decoded=0
def scan(b,n):assert not any(x.search(b) for x in patterns),'SECRET_PATTERN:'+str(n)
def walk(v,n):
 global decoded
 if isinstance(v,dict):
  for k,x in v.items():
   if k in ['sourceBase64','recoverySourceBase64'] and isinstance(x,str):scan(base64.b64decode(x,validate=True),n);decoded+=1
   walk(x,n)
 elif isinstance(v,list):
  for x in v:walk(x,n)
 elif isinstance(v,str):
  for x in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}',v):
   try:
    b=base64.b64decode(x,validate=True)
    if b.startswith(b'\x1f\x8b'):b=gzip.decompress(b)
    scan(b,n);decoded+=1
   except (ValueError,OSError,EOFError):pass
for p in files:
 b=p.read_bytes();scan(b,p)
 if p.suffix=='.py':ast.parse(b);py+=1
 elif p.suffix=='.mjs':q=subprocess.run(['node','--check',str(p)],capture_output=True);assert q.returncode==0;node+=1
 elif p.suffix=='.json':walk(json.loads(b),p)
q=subprocess.run(['git','diff',sha,'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],capture_output=True);assert q.returncode==0 and not q.stdout,'APPLICATION_SOURCE_DRIFT'
q=subprocess.run(['git','diff','--check'],capture_output=True);assert q.returncode==0
summary={'gate':'PASS','scope':'LOCAL_FAILED_R0_ORIGINAL_PRESERVATION_EXACT_RECOVERY_RESTORE_HYGIENE','sourceCommit':sha,'filesScanned':len(files),'pythonAst':py,'nodeSyntax':node,'decodedSourceBlocks':decoded,'secretPatternHits':0,'applicationSourceUnchanged':True,'originalExecutionGate':'FAIL','r1Gate':'NOT_RUN','cleanupRecoveryGate':'PASS','restoreGate':'PASS','p95Accepted':False,'fullQa09Accepted':False}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
bound={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
manifest={'gate':'PARTIAL','scope':'SAME_SHA_FAILED_R0_ORIGINAL_PHASE_DIAGNOSIS_EXACT_CLEANUP_AND_DEFAULT_RESTORE','sourceCommit':sha,'r0OriginalExecutionGate':'FAIL','r0CleanupGate':'PASS','r1Gate':'NOT_RUN','restoreGate':'PASS','postRestoreReadOnlyGate':'PASS','samplingStrictGate':'BLOCKED_ORIGINAL_CHILD_FAIL','p95Accepted':False,'fullQa09Accepted':False,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fileCount':len(bound),'files':bound}
assert not (root/'manifest.json').exists();(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(summary))
