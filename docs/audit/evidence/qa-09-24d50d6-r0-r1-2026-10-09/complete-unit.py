"""Seal an already completed bounded unit, without running probes or changing AWS."""
import json,sys,hashlib,datetime,base64
from pathlib import Path
root=Path(__file__).parent
mode=sys.argv[1]
assert mode in ('r0','r1')
p=root/mode
bindings={}
def read(name):
 b=(p/name).read_bytes();bindings[name]=hashlib.sha256(b).hexdigest();return json.loads(b)
initial,final=read('api-config.json'),read('api-final-config.json')
capacity,last=read('api-concurrency.json'),read('api-final-concurrency.json')
assert initial==final and capacity==last
assert initial['engineCpu']=='true' and initial['preconnect']==str(mode!='restore').lower()
assert initial['accountReadCandidate']==str(mode=='r1').lower()
assert initial['contractLoadDetail']=='true'
assert initial['memory']==512 and initial['pool']=='1' and initial['envName']=='test'
assert capacity['ReservedConcurrentExecutions']==12
(p/'final-config-binding.json').write_text(json.dumps({'gate':'PASS','scope':'INITIAL_AND_FINAL_SAFE_API_CONFIG_AND_CAPACITY','bindings':dict(bindings)},indent=2)+'\n')
session=read('renewable-session-gate.json');assert session['gate']=='PASS'
if (p/'auth-resume/runtime-binding.json').exists():
 resume=read('auth-resume/runtime-binding.json');assert resume['gate']=='PASS'
 for n,h in resume['bindings'].items():
  f=Path(n) if n.startswith('docs/') else p/'auth-resume'/n
  assert hashlib.sha256(f.read_bytes()).hexdigest()==h,'AUTH_RESUME_BINDING_DRIFT'
 for n in ['auth-resume/runtime.json','auth-resume/actual-config.json','auth-resume/capacity-recovery/capacity-before-gate.json','auth-resume/capacity-recovery/renewable-session-gate.json','auth-resume/capacity-recovery/actual-config.json','auth-resume/capacity-recovered.json']:read(n)
provenance=read('deployment-input-binding.json')
version=read('application-version.json')
child=read('sample.json');parent=read('sample.json.fixtures.json');assert child['gate']==parent['gate']=='PASS' and child['cleanupComplete'] and all(x['result']=='PASS' for x in child['cleanup']+parent['cleanup']), 'ORIGINAL_COMPLETE_UNIT_REQUIRED'
parentSnapshot=read('sample.json.sources.json');parentSource=next(x for x in parentSnapshot['sources'] if x['path']=='scripts/qa09-nonactive-cleanup.mjs');assert parentSource['sha256']==hashlib.sha256(Path(parentSource['path']).read_bytes()).hexdigest()==hashlib.sha256(base64.b64decode(parentSource['sourceBase64'])).hexdigest()
for doc in [child,parent]:
 assert doc['cleanupOperations'] and all(x['result']=='PASS' or (x['result']=='FAIL' and x.get('expectedOutcome')=='ABSENT_IDENTITY' and x['failure']['errorName']=='UserNotFoundException') for x in doc['cleanupOperations']), 'CLEANUP_OPERATION_PROOF_REQUIRED'
for name in ['qa09-operation-observation.mjs','qa09-started-build-read.mjs','qa09-ten-device-bridge.mjs','qa09-db-frame-wait.mjs']:
 path='scripts/'+name;expected=hashlib.sha256(Path(path).read_bytes()).hexdigest()
 source=next(v for v in child['sources'] if v['path']==path)
 assert source['sha256']==child['sourceHashes'][path]==expected and hashlib.sha256(base64.b64decode(source['sourceBase64'])).hexdigest()==expected, 'NEW_EXECUTOR_SOURCE_BINDING_REQUIRED'
for doc in [child,parent]:
 for row in doc['databaseBuilds']:
  receiptPath=Path(row['receipt']).resolve();assert receiptPath.parent==p.resolve(), 'OWN_UNIT_RECEIPT_PATH_REQUIRED'
  d=read(receiptPath.name)
  assert row.get('gate')=='PASS', 'ORIGINAL_LEDGER_SCHEMA_REQUIRED'
  assert d['gate']=='PASS' and d['build']['status']=='SUCCEEDED' and d['build']['id']==row['buildId']
  assert d['build']['serviceRole']=='arn:aws:iam::065986019555:role/fdp-test-migration-runner-role'
  assert d['result']['prefix']==doc['prefix'] and d['result']['action']==row['action'] and d['result']['sourceHash']==child['sourceHashes']['scripts/qa09-ten-device-db.mjs'], 'EXACT_BUILD_PLAN_SOURCE_REQUIRED'
  assert d['operations'] and d['buildReads'] and d['readGate'] in ['PASS','RECOVERED'] and d['originalReadGate'] in ['PASS','FAIL']
  if d['readGate']=='PASS':assert d['originalReadGate']=='PASS'
  else:assert d['originalReadGate']=='FAIL' and (any(x['result']=='FAIL' for x in d['buildReads']) or any(x.get('errorCode') for x in d['resultReadObservations']))
negative=read('negative-gate.json')
wrapper=read('sample.json.gate.json');assert wrapper['parentCleanupObservation']['gate']=='PASS' and wrapper['parentCleanupObservation']['scope']=='ORIGINAL_PARENT_CLEANUP_OPERATIONS_ONLY'
empty=read('database-empty-audit.json')
for name in ('baseline-phases.json','sampling-phases.json'):
 phaseReceipt=read(name);assert phaseReceipt['gate']=='PASS' and phaseReceipt['contractLoadSplitRequired'] is True and phaseReceipt['contractLoadDetailRequired'] is True
for name,group,analysis in [('baseline-cold-phases','baseline','baseline-cold-analysis'),('cold-phases','sampling','cold-analysis')]:
 proof=p/(name+'.json')
 if proof.exists():
  assert read(name+'.json')['gate']=='PASS'
 else:
  assert read(group+'-phases.json')['coldConflictObservedCount']==0
  code=p/(name+'.exit');error=p/(name+'.stderr.log')
  assert int(code.read_text())!=0 and 'COLD_CONFLICT_REQUIRED' in error.read_text()
  for f in (code,error):bindings[f.name]=hashlib.sha256(f.read_bytes()).hexdigest()
  absent=read(analysis+'.json')
  assert absent['gate']=='NOT_RUN' and absent['reason']=='COLD_CONFLICT_NOT_OBSERVED'

peak=read('connection-budget-gate.json')
assert peak['gate']=='PASS' and peak['observedMaximum']<=70
target=read('target-summary.json')
runtime=read('runtime-assembly-analysis.json')
if mode!='restore':assert read('initial-topology-gate.json')['gate']=='PASS'
for name in ('runtime-final-binding.json','final-config-binding.json','cdk-diff-summary.json'):
 assert read(name)['gate']=='PASS'
assert provenance['gate']=='PASS' and version['gate']=='PASS' and len(version['lambdaArtifacts'])==19
assert negative['gate']=='PASS' and wrapper['gate']=='PASS' and empty['gate']=='PASS'
assert target['businessGate']=='PASS' and target['cleanup']=='PASS' and target['businessChecks']==123
assert runtime['gate']=='PASS' and runtime['negativeNoSqlGate']=='PASS' and runtime['negativeRequests']==12
assert target['sourceCommit']==version['sourceCommit']=='24d50d6c3a9000c629d8255f78ea8d57a9d5b3f7'
result={'gate':'PASS','scope':'BOUNDED_'+mode.upper()+'_UNIT_VERSION_BUSINESS_PHASE_AND_OWN_CLEANUP_ONLY','sourceCommit':target['sourceCommit'],'runId':provenance['runId'],'prefix':target['prefix'],'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'businessChecks':target['businessChecks'],'negativeRequests':12,'exactPhaseRequests':target['phaseRequests']+target['samplingPhaseRequests'],'runtimeObserved':runtime['runtimeObserved'],'baselineCold409':target['baselineColdConflictObservedCount'],'samplingCold409':target['samplingColdConflictObservedCount'],'cleanup':'PASS','originalExecutionGate':'PASS','cleanupRecovery':False,'independentEmptyAudit':'PASS','bindings':bindings,'fullQa09Accepted':False,'p95Accepted':False}
assert result['exactPhaseRequests']==55
assert not (p/'unit-completion.json').exists(), 'PRESERVE_EXISTING_CLOSURE'
(p/'unit-completion.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
