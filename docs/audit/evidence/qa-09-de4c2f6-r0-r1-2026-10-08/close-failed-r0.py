"""Owned cleanup admission for restoration only; does not accept failed client split."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;p=root/'r0';bindings={}
def read(n):
 b=(p/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
child=read('sample.json');parent=read('sample.json.fixtures.json');wrapper=read('sample.json.gate.json');empty=read('database-empty-audit.json');budget=read('connection-budget-gate.json');version=read('application-version.json');runtime=read('runtime-final.json');cfg=read('api-config.json');end=read('api-final-config.json');conc=read('api-concurrency.json');last=read('api-final-concurrency.json')
assert child['gate']=='PASS' and child['cleanupComplete'] and len(child['checks'])==123 and all(c['result']=='PASS' for c in child['cleanup'])
assert parent['gate']=='PASS' and parent['globalSignOut']=='PASS' and all(c['result']=='PASS' for c in parent['cleanup']) and wrapper['gate']==empty['gate']==budget['gate']==version['gate']=='PASS'
assert runtime['sourceCommit']==version['sourceCommit'] and len(runtime['lambdaArtifacts'])==19 and not runtime['blockers']
for a in version['lambdaArtifacts']:
 assert any(b['name']==a['name'] and all(a[k]==b[k] for k in ['codeSha256','revisionId','runtime','state','lastUpdateStatus']) for b in runtime['lambdaArtifacts']),'RUNTIME_DRIFT'
assert cfg==end and conc==last and cfg['accountReadCandidate']=='false' and cfg['preconnect']=='true'
assert int((p/'check-unit.closure.exit').read_text())!=0 and 'CLIENT_SPLIT_BOUNDARY' in (p/'baseline-phases.stderr.log').read_text()
for n in ['check-unit.closure.exit','baseline-phases.stderr.log','baseline-phases.exit']:bindings[n]=hashlib.sha256((p/n).read_bytes()).hexdigest()
for n in ['baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json','negative-gate.json','deployment-input-binding.json','cdk-diff-summary.json']:assert read(n)['gate']=='PASS'
result={'gate':'PASS','scope':'R0_OWN_BUSINESS_CLEANUP_ONLY_WITH_FAILED_STAGE_GATE','sourceCommit':version['sourceCommit'],'runId':'37710260861','prefix':child['prefix'],'businessChecks':123,'exactCorrelatedRequests':55,'negativeRequests':12,'cleanup':'PASS','independentEmptyAudit':'PASS','runtimeFinalBinding':'INITIAL_ZIP_BYTES_WITH_EXACT_FINAL_19_METADATA','stageGate':'FAIL','stageFailure':'CLIENT_SPLIT_BOUNDARY_ORIGINAL_CAPTURE','r1Gate':'NOT_RUN','restoreRequired':True,'bindings':bindings,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'p95Accepted':False,'fullQa09Accepted':False}
assert not (p/'cleanup-only-completion.json').exists();(p/'cleanup-only-completion.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
