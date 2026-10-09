"""Admit default restoration only after original successful cleanup and independent empty proof."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;p=root/'r0';bindings={}
def read(n):
 b=(p/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
child=read('sample.json');parent=read('sample.json.fixtures.json');wrapper=read('sample.json.gate.json');version=read('application-version.json');deploy=read('deployment-input-binding.json');config=read('actual-config.json');empty=read('database-empty-audit.json');domain=read('sample.json.domain-cleanup.json')
sha='f7abb0670398a1254fcf45755f077b41f4fcd4c0'
assert child['gate']==parent['gate']=='PASS' and wrapper['gate']=='FAIL' and wrapper['reason']=='EXECUTED_SOURCE_DRIFT'
assert child['sourceCommit']==parent['sourceCommit']==version['sourceCommit']==sha
assert child['cleanupComplete'] and len(child['checks'])==123 and all(c['result']=='PASS' for c in child['checks'])
assert all(c['result']=='PASS' for c in child['cleanup']+parent['cleanup'])
assert child['prefix']==parent['prefix']==empty['result']['prefix'] and empty['gate']=='PASS' and empty['result']['empty'] is True
assert domain['gate']=='PASS' and len(domain['observations'])==2 and all(x['versionsRemaining']==0 for x in domain['observations']) and domain['parentReceiptSha256']==bindings['sample.json.fixtures.json']
assert parent['globalSignOut']=='PASS'
assert sum(c['type']=='database-fixtures' and c['count']==10 for c in parent['cleanup'])==1
assert sorted(c['id'] for c in parent['cleanup'] if c['type']=='customer')==sorted(c['id'] for c in parent['customers'])
assert any(c['type']=='identity' and c['username']==parent['identity']['username'] for c in parent['cleanup'])
for doc in [child,parent]:
 for row in doc['databaseBuilds']:
  f=Path(row['receipt']).resolve();assert f.parent==p.resolve()
  d=read(f.name);assert d['gate']=='PASS' and d['build']['status']=='SUCCEEDED' and d['build']['id']==row['buildId']
  assert d['build']['serviceRole']=='arn:aws:iam::065986019555:role/fdp-test-migration-runner-role'
  assert d['result']['prefix']==child['prefix'] and d['result']['action']==row['action'] and d['result']['sourceHash']==child['sourceHashes']['scripts/qa09-ten-device-db.mjs']
first=next(x for x in parent['databaseBuilds'] if x['action']=='observe');initial=read(Path(first['receipt']).name)
assert empty['result']['originalFingerprints']==initial['result']['originalFingerprints']
assert version['gate']==deploy['gate']==config['gate']=='PASS' and len(version['lambdaArtifacts'])==19
read('business-window.json')
result={'gate':'PASS','scope':'R0_ORIGINAL_CLEANUP_ONLY_WITH_INDEPENDENT_EMPTY_NO_EXECUTION_UPGRADE','sourceCommit':sha,'runId':deploy['runId'],'prefix':child['prefix'],'originalExecutionGate':'FAIL','stageGate':'FAIL','stageFailure':'EXECUTED_SOURCE_DRIFT','businessChecksPassed':123,'cleanup':'PASS','independentEmptyAudit':'PASS','cleanupRecovery':False,'r1Gate':'NOT_RUN','restoreRequired':True,'bindings':bindings,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'p95Accepted':False,'fullQa09Accepted':False}
assert not (p/'cleanup-only-completion.json').exists();(p/'cleanup-only-completion.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
