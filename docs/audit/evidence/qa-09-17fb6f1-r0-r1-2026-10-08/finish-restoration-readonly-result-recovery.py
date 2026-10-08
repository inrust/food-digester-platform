"""Close final read-only check using the original own Build recovered through ReadOnlyOps; no AWS calls."""
import datetime,hashlib,json
from pathlib import Path
root=Path(__file__).parent;p=root/'restore'
read=lambda n:json.loads((p/n).read_text())
restore=read('restore-completion.json');assert restore['gate']=='PASS'
for n,h in restore['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
assert (p/'audit-empty.readonly.exit').read_text().strip()=='1'
assert 'AWS_batch-get-builds_SSO_SESSION_EXPIRED' in (p/'audit-empty.readonly.stderr.log').read_text()
original=read('database-empty-audit.json');recovered=read('database-empty-audit.recovered.json');prep=read('database-empty-audit.json.preparation.json')
assert original['gate']=='RUNNING' and recovered['gate']=='PASS' and recovered['writes']==0
assert recovered['recoveredFromSha256']==hashlib.sha256((p/'database-empty-audit.json').read_bytes()).hexdigest()
assert recovered['preparationSha256']==hashlib.sha256((p/'database-empty-audit.json.preparation.json').read_bytes()).hexdigest()
assert recovered['build']['id']==original['build']['id'] and recovered['build']['status']=='SUCCEEDED'
assert recovered['result']['gate']=='PASS' and recovered['result']['action']=='audit-empty' and recovered['result']['prefix']==prep['plan']['prefix']
assert read('capacity-before-gate.json')['gate']=='PASS'
assert not (p/'post-restoration-readonly.json').exists()
files=['restore-completion.json','actual-config.json','capacity-before.json','capacity-before-gate.json','database-empty-audit.json','database-empty-audit.json.preparation.json','database-empty-audit.recovered.json','audit-empty.readonly.exit','audit-empty.readonly.stderr.log','audit-result-recovery.exit']
result={'gate':'PASS','scope':'RESTORED_DEFAULT_OFF_WITH_FRESH_READ_ONLY_CAPACITY_AND_OWN_EMPTY_AUDIT','sourceCommit':restore['sourceCommit'],'runId':restore['runId'],'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'newBusinessFixtures':0,'newBusinessRequests':0,'newAuditBuildOnRecovery':False,'originalAuditClientGate':'FAIL','originalAuditFailure':'SSO_SESSION_EXPIRED_DURING_BUILD_POLL','effectiveAuditGate':'PASS','resultRecoveryProfile':'esgiot-readonly','budgetScope':'STATIC_AND_READ_ONLY_SNAPSHOT_NOT_NEW_LOAD','bindings':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in files},'p95Accepted':False,'fullQa09Accepted':False}
assert (p/'audit-result-recovery.exit').read_text().strip()=='0'
(p/'post-restoration-readonly.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
