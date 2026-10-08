"""Bind actual cleanup recovery to the unchanged business capture; preserve original FAIL."""
import pathlib,json,hashlib,datetime
root=pathlib.Path(__file__).parent;p=root/'r0'
def read(n):return json.loads((p/n).read_text())
def digest(n):return hashlib.sha256((p/n).read_bytes()).hexdigest()
a=read('sample.json.fixtures.json');child=read('sample.json');r=read('parent-cleanup-recovery.json');domain=read('parent-cleanup-recovery.json.domain-cleanup.json')
assert a['gate']=='FAIL' and child['gate']=='PASS' and child['cleanupComplete'] and len(child['checks'])==123 and r['gate']=='PASS' and r['prefix']==a['prefix']==child['prefix'] and r['sourceCommit']==a['sourceCommit']==child['sourceCommit']
assert all(x['result']=='PASS' for x in r['checks']+r['cleanup']) and r['globalSignOut']=='PASS' and not r['patchReplay'] and not r['samplingReplay']
for x in r['inputs']:assert hashlib.sha256(pathlib.Path(x['path']).read_bytes()).hexdigest()==x['sha256']
assert r['cleanup'][-1]=={'type':'license-domain-archive','result':'PASS'}
closed={**r,'cleanup':r['cleanup'][:-1]};closedBytes=(json.dumps(closed,ensure_ascii=False,indent=2)+'\n').encode()
assert domain['gate']=='PASS' and domain['parentReceiptSha256']==hashlib.sha256(closedBytes).hexdigest() and len(domain['observations'])==2 and all(x['versionsRemaining']==0 for x in domain['observations'])
closedName='parent-cleanup-recovery.json.domain-parent-snapshot.json';assert not (p/closedName).exists();(p/closedName).write_bytes(closedBytes)
for c in a['customers']:assert any(x['type']=='customer' and x['id']==c['id'] for x in r['cleanup'])
assert any(x['type']=='identity' and x['username']==a['identity']['username'] for x in r['cleanup'])
builds=a['databaseBuilds']+[{'action':'observe','receipt':str(p/'parent-observe-recovered.json'),'buildId':read('parent-observe-recovered.json')['build']['id']}]+r['databaseBuilds']
for x in builds:
 v=json.loads(pathlib.Path(x['receipt']).read_text());assert v['gate']=='PASS' and v['result']['prefix']==a['prefix'] and v['result']['action']==x['action'] and v['build']['id']==x['buildId'] and v['build']['status']=='SUCCEEDED'
effective={**a,'gate':'PASS','scope':'RECOVERED_PARENT_CLEANUP_COMPOSITE_ORIGINAL_EXECUTION_FAILED','originalExecutionGate':'FAIL','originalParentSha256':digest('sample.json.fixtures.json'),'recoveryReceiptSha256':digest('parent-cleanup-recovery.json'),'cleanup':r['cleanup'],'databaseBuilds':builds,'finishedAt':r['finishedAt'],'originalCleanupFailures':a['cleanup'],'originalFailedChecks':[x for x in a['checks'] if x['result']!='PASS'],'checks':[x for x in a['checks'] if x['result']=='PASS']+r['checks']}
wrapper={'task':'QA-09','gate':'PASS','scope':'UNCHANGED_BOUND_BUSINESS_WITH_EXACT_RECOVERED_PARENT_CLEANUP','sourceCommit':child['sourceCommit'],'prefix':child['prefix'],'cleanup':'PASS','originalExecutionGate':'FAIL','originalWrapperSha256':digest('sample.json.gate.json'),'sourceReceiptSha256':digest('sample.json.sources.json'),'fullQa09Accepted':False,'p95Accepted':False}
for n,v in [('sample.json.fixtures.effective.json',effective),('sample.json.gate.effective.json',wrapper)]:
 assert not (p/n).exists();(p/n).write_text(json.dumps(v,indent=2)+'\n')
print('recovered parent composite PASS; original parent and wrapper remain FAIL')
