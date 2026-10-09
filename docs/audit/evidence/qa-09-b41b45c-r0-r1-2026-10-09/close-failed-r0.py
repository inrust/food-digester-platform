"""Admit same-SHA default restoration after independently verified exact cleanup only."""
import datetime,hashlib,json
from pathlib import Path
root=Path(__file__).parent;p=root/'r0';bindings={}
def read(n):
 b=(p/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
child=read('sample.json');parent=read('sample.json.fixtures.json');recovery=read('cleanup-recovery-completion.json')
version=read('application-version.json');runtime=read('runtime-final.json');deploy=read('deployment-input-binding.json');config=read('actual-config.json');budget=read('connection-budget-gate.json')
sha='b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e'
assert child['gate']==parent['gate']=='FAIL' and child['checks'] and len(child['checks'])==115 and all(c['result']=='PASS' for c in child['checks'])
assert child['sourceCommit']==parent['sourceCommit']==recovery['sourceCommit']==version['sourceCommit']==runtime['sourceCommit']==sha
assert child['cleanupFailure']['code']=='AWS_batch-get-builds_CLI_FAILED' and child['cold409Sampling']['gate']=='PASS' and len(child['cold409Sampling']['attempts'])==12
assert recovery['gate']=='PASS' and recovery['originalExecutionGate']=='FAIL' and recovery['independentEmptyAudit']=='PASS' and recovery['prefix']==child['prefix']==parent['prefix']
assert all(c['result']=='PASS' for c in recovery['cleanup'])
for n,h in recovery['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,'RECOVERY_INPUT_DRIFT'
assert recovery['executorSha256']==hashlib.sha256((root/'complete-r0-cleanup.mjs').read_bytes()).hexdigest()
assert sum(c['type']=='database-fixtures' and c['count']==10 for c in recovery['cleanup'])==1
assert sorted(c['id'] for c in recovery['cleanup'] if c['type']=='site')==sorted(c['id'] for c in child['createdSites'])
assert sorted(c['id'] for c in recovery['cleanup'] if c['type']=='customer')==sorted(c['id'] for c in parent['customers'])
expected=sorted(c['username'] for c in child['createdIdentities']+[parent['identity']])
assert sorted(c['username'] for c in recovery['cleanup'] if c['type']=='identity')==expected
assert all(c['globalSignOut'] in ['PASS','ALREADY_ABSENT'] for c in recovery['cleanup'] if c['type']=='identity')
assert any(c['type']=='recovery-identity' and c['globalSignOut']=='PASS' for c in recovery['cleanup'])
for b in recovery['databaseBuilds']:
 n=Path(b['receipt']).name;v=read(n)
 assert v['gate']=='PASS' and v['build']['status']=='SUCCEEDED' and v['build']['id']==b['buildId'] and v['build']['serviceRole']=='arn:aws:iam::065986019555:role/fdp-test-migration-runner-role'
 assert v['result']['prefix']==child['prefix'] and v['result']['action']==b['action']
empty=read('cleanup-recovery-completion.json.audit-empty.json');assert empty['result']['empty'] is True
domain=read('cleanup-recovery-completion.json.domain-cleanup.json');ledger=read('cleanup-recovery-completion.json.closed-ledger.json')
assert domain['gate']=='PASS' and len(domain['observations'])==2 and all(c['versionsRemaining']==0 for c in domain['observations']) and domain['parentReceiptSha256']==bindings['cleanup-recovery-completion.json.closed-ledger.json']
assert version['gate']==deploy['gate']==config['gate']==budget['gate']=='PASS' and len(version['lambdaArtifacts'])==len(runtime['lambdaArtifacts'])==19 and not runtime['blockers']
for a in version['lambdaArtifacts']:
 assert any(b['name']==a['name'] and all(a[k]==b[k] for k in ['codeSha256','revisionId','runtime','state','lastUpdateStatus']) for b in runtime['lambdaArtifacts']),'RUNTIME_DRIFT'
assert config['config']['contractLoadDetail']=='true' and config['config']['preconnect']=='true' and config['config']['accountReadCandidate']=='false'
for n in ['baseline-phases.json','baseline-cold-phases.json']:
 v=read(n);assert v['gate']=='PASS' and v['contractLoadDetailRequired'] is True and v['contractLoadSplitRequired'] is True
for n in ['baseline-patch.json','baseline-audit.json','business-cleanup-recovered.json','cdk-diff-summary.json']:assert read(n)['gate']=='PASS'
for n in ['cleanup-recovery.json','cleanup-recovery.json.business-audit.json','cleanup-recovery.json.observe.json','cleanup-recovery.json.cleanup.json']:read(n)
for n in ['sample.json.gate.json','business-window.json','cleanup-cloudtrail-diagnostic.json']:read(n)
result={'gate':'PASS','scope':'R0_EXACT_RECOVERED_CLEANUP_ONLY_ORIGINAL_EXECUTION_FAIL','sourceCommit':sha,'runId':deploy['runId'],'prefix':child['prefix'],'originalExecutionGate':'FAIL','businessChecksPassed':115,'contractDetailGate':'PASS','exactBaselineRequests':25,'samplingBusinessLedger':'PASS','samplingStrictGate':'BLOCKED_ORIGINAL_CHILD_FAIL','negativeRequestsGate':'NOT_RUN','stageGate':'FAIL','stageFailure':'ORIGINAL_CLEANUP_CONTROL_CHANNEL_FAILURE','cleanup':'PASS','independentEmptyAudit':'PASS','runtimeFinalBinding':'INITIAL_ZIP_BYTES_WITH_EXACT_FINAL_19_METADATA','r1Gate':'NOT_RUN','restoreRequired':True,'bindings':bindings,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'p95Accepted':False,'fullQa09Accepted':False}
assert not (p/'cleanup-only-completion.json').exists()
(p/'cleanup-only-completion.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
