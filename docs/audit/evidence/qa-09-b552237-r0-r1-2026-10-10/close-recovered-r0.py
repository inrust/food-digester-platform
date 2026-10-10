"""Allow restoration after exact compensating cleanup; never upgrade the original failed unit."""
from pathlib import Path
import json,hashlib,datetime,base64,subprocess
root=Path(__file__).parent;p=root/'r0';bindings={};sha='b5522378aebca9340a0767b53ed3bab846ffc080'
def read(n):
 b=(p/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
a=read('sample.json.fixtures.json');c=read('sample.json');w=read('sample.json.gate.json');r=read('parent-cleanup-recovery.json');e=read('database-empty-audit.json');d=read('parent-cleanup-recovery.json.domain-cleanup.json');snapshot=read('parent-cleanup-recovery.json.domain-parent-snapshot.json')
assert a['gate']==w['gate']=='FAIL' and c['gate']==r['gate']=='PASS' and c['cleanupComplete']
assert a['sourceCommit']==c['sourceCommit']==r['sourceCommit']==sha
assert a['prefix']==c['prefix']==r['prefix']==e['result']['prefix']
assert len(c['checks'])==123 and all(x['result']=='PASS' for x in c['checks']+c['cleanup']+r['checks']+r['cleanup'])
assert a['globalSignOut']==r['globalSignOut']=='PASS' and r['patchReplay'] is False and r['samplingReplay'] is False
for x in r['inputs']:assert hashlib.sha256(Path(x['path']).read_bytes()).hexdigest()==x['sha256']
for x in a['customers']:assert any(k['type']=='customer' and k['id']==x['id'] for k in r['cleanup'])
assert any(k['type']=='identity' and k['username']==a['identity']['username'] for k in r['cleanup'])
assert sum(k['type']=='database-fixtures' and k['count']==10 for k in r['cleanup'])==1
failed=read(Path(a['databaseBuilds'][-1]['receipt']).name)
assert failed['gate']=='FAIL' and not failed.get('build') and failed['failure']['kind']=='PRE_START_OR_MUTATION_FAILURE' and failed['failure']['startedBuildMayStillRun'] is False
assert len(failed['operations'])==2 and failed['operations'][1]['operation']=='batch-get-projects' and failed['operations'][1]['result']=='FAIL'
assert e['gate']=='PASS' and e['result']['empty'] is True and e['build']['status']=='SUCCEEDED'
first=read(Path(a['databaseBuilds'][0]['receipt']).name)
assert e['result']['originalFingerprints']==first['result']['originalFingerprints']
assert all(not e['result'][k] for k in ['devices','certificates','onboardingRequests'])
for n in ['parent-observe-recovered.json',*[Path(x['receipt']).name for x in r['databaseBuilds']],'database-empty-audit.json']:
 b=read(n);assert b['gate']=='PASS' and b['build']['status']=='SUCCEEDED' and b['build']['serviceRole']=='arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' and b['result']['sourceHash']==c['sourceHashes']['scripts/qa09-ten-device-db.mjs'] and b['result']['prefix']==c['prefix']
assert d['gate']=='PASS' and d['parentReceiptSha256']==bindings['parent-cleanup-recovery.json.domain-parent-snapshot.json'] and len(d['observations'])==2 and all(x['versionsRemaining']==0 for x in d['observations'])
for s in read('sample.json.sources.json')['sources']:
 assert hashlib.sha256(base64.b64decode(s['sourceBase64'])).hexdigest()==s['sha256']==hashlib.sha256(subprocess.check_output(['git','show',sha+':'+s['path']])).hexdigest()
for n in ['baseline-phases.json','sampling-phases.json']:
 x=read(n);assert x['gate']=='PASS' and x['contractAwaitCheckpointRequired'] is True
assert read('negative-gate.json')['gate']=='PASS'
for n in ['application-version.json','deployment-input-binding.json','actual-config.json','runtime-final-binding.json']:assert read(n)['gate']=='PASS'
result={'gate':'PASS','scope':'EXACT_R0_COMPENSATING_CLEANUP_ONLY_ORIGINAL_UNIT_FAIL_PRESERVED','sourceCommit':sha,'runId':'38008861924','prefix':c['prefix'],'originalExecutionGate':'FAIL','stageGate':'FAIL','stageFailure':'ORIGINAL_PARENT_PRE_START_NETWORK_READ_AND_DEPENDENT_CUSTOMER_CLEANUP_FAILURE','contractStageGate':'PASS','businessChecksPassed':123,'cleanup':'PASS','independentEmptyAudit':'PASS','cleanupRecovery':True,'r1Gate':'NOT_RUN','restoreRequired':True,'cleanupEntries':r['cleanup'],'bindings':bindings,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'p95Accepted':False,'fullQa09Accepted':False}
for n in ['cleanup-recovery-completion.json','cleanup-only-completion.json']:
 assert not (p/n).exists()
 copy=dict(result)
 if n=='cleanup-recovery-completion.json':copy['cleanup']=r['cleanup']
 (p/n).write_text(json.dumps(copy,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['bindings','cleanupEntries']}))
