"""Close residual-absence verification only; preserve all original failed Gates."""
from pathlib import Path
import json,hashlib,datetime,base64,subprocess
root=Path(__file__).parent.parent;p=root/'r0';sha='ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2';bindings={}
def read(n):
 b=(p/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
child=read('sample.json');parent=read('sample.json.fixtures.json');wrapper=read('sample.json.gate.json');cleanup=read('sample.json.business-cleanup-1.json');baseline=read('sample.json.business-baseline-0.json');unknown=read('sample.json.business-audit-2.json');domain=read('sample.json.domain-cleanup.json');empty=read('database-empty-audit.json');entry=read('independent-empty-audit-entry.json')
assert child['gate']==parent['gate']==wrapper['gate']=='FAIL'
assert child['sourceCommit']==parent['sourceCommit']==sha and child['prefix']==parent['prefix']==empty['result']['prefix']
assert all(x['result']=='PASS' for x in child['checks']) and len(child['checks'])==116
assert cleanup['gate']==baseline['gate']=='PASS' and cleanup['build']['status']=='SUCCEEDED'
assert all(n==0 for n in cleanup['result']['counts'].values()) and cleanup['result']['businessFingerprints']==baseline['result']['businessFingerprints']
assert unknown['gate']=='FAIL' and not unknown.get('build') and unknown['failure']['kind']=='START_OUTCOME_UNCONFIRMED' and unknown['failure']['startedBuildMayStillRun'] is True
assert all(x['result']=='PASS' for x in parent['cleanup']) and parent['globalSignOut']=='PASS'
assert all(x['result']=='PASS' or (x['operation']=='cognito:AdminGetUserCommand' and x['expectedOutcome']=='ABSENT_IDENTITY' and x['failure']['errorName']=='UserNotFoundException') for x in parent['cleanupOperations'])
assert len(parent['cleanup'])==4 and domain['gate']=='PASS' and len(domain['observations'])==2 and all(x['versionsRemaining']==0 for x in domain['observations'])
assert domain['parentReceiptSha256']==bindings['sample.json.fixtures.json']
users=child['cleanup'][1:];assert len(users)==4 and all(x['type']=='cognito' and x['deletion']==x['absence']=='PASS' and x['absenceProof']=='UserNotFoundException' for x in users)
assert all(x['globalSignOut']=='PASS' for x in users)
assert empty['gate']=='PASS' and empty['result']['empty'] is True and empty['build']['status']=='SUCCEEDED'
for n,h in entry['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
first=read(Path(parent['databaseBuilds'][0]['receipt']).name)
assert empty['result']['originalFingerprints']==first['result']['originalFingerprints']
for row in parent['databaseBuilds']:
 b=read(Path(row['receipt']).name);assert row['gate']=='PASS' and b['gate']=='PASS' and b['build']['status']=='SUCCEEDED' and b['build']['id']==row['buildId'] and b['result']['prefix']==child['prefix']
for b in [cleanup,empty,*[json.loads((p/Path(row['receipt']).name).read_text()) for row in parent['databaseBuilds']]]:
 assert b['build']['serviceRole']=='arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' and b['result']['sourceHash']==child['sourceHashes']['scripts/qa09-ten-device-db.mjs']
for s in read('sample.json.sources.json')['sources']:
 assert hashlib.sha256(base64.b64decode(s['sourceBase64'])).hexdigest()==s['sha256']==hashlib.sha256(subprocess.check_output(['git','show',sha+':'+s['path']])).hexdigest()
for n in ['application-version.json','actual-config.json','deployment-input-binding.json','artifact-transition.json']:assert read(n)['gate']=='PASS'
facts=[{'type':'COMMITTED_BUSINESS_CLEANUP_COUNTS_ZERO','result':'PASS'},{'type':'ORIGINAL_PARENT_OWN_CLEANUP','result':'PASS'},{'type':'INDEPENDENT_DATABASE_EMPTY_AUDIT','result':'PASS'},{'type':'ORIGINAL_DOMAIN_VERSIONS_EMPTY','result':'PASS'}]+[{'type':'IDENTITY_ABSENCE_ONLY','username':x['username'],'result':'PASS','originalGlobalSignOut':x['globalSignOut'],'globalSignOutSuccessClaimed':False} for x in users]
result=dict(gate='PASS',scope='OWN_R0_RESIDUAL_ABSENCE_VERIFICATION_ONLY_ORIGINAL_UNIT_FAIL_PRESERVED',sourceCommit=sha,runId='38205220594',prefix=child['prefix'],originalExecutionGate='FAIL',originalChildCleanupGate='FAIL',originalParentAggregateGate='FAIL',originalGlobalSignOutGate='PASS',unknownBusinessAuditStart='UNKNOWN',stageGate='FAIL',stageFailure='UNKNOWN_READ_ONLY_BUSINESS_AUDIT_START',businessChecksPassed=116,cleanup='PASS',independentEmptyAudit='PASS',cleanupVerificationRecovery=True,compensatingCleanupWrites=0,businessReplays=0,r1Gate='NOT_RUN',restoreRequired=True,bindings=bindings,finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),p95Accepted=False,fullQa09Accepted=False)
for n in ['cleanup-only-completion.json','cleanup-recovery-completion.json']:
 assert not (p/n).exists();v=dict(result)
 if n=='cleanup-recovery-completion.json':v['cleanup']=facts
 (p/n).write_text(json.dumps(v,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
