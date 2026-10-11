"""Only certify original R1 business and cleanup after failed bounded log reads; never a stage PASS."""
import json,hashlib,datetime,base64
from pathlib import Path
root=Path(__file__).resolve().parent;p=root/'r1';bindings={};out=p/'cleanup-only-completion.json';assert not out.exists()
def read(name):
 b=(p/name).read_bytes();bindings[name]=hashlib.sha256(b).hexdigest();return json.loads(b)
child=read('sample.json');parent=read('sample.json.fixtures.json')
assert child['gate']==parent['gate']=='PASS' and child['cleanupComplete'] and all(x['result']=='PASS' for x in child['cleanup']+parent['cleanup'])
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
  else:assert d['originalReadGate']=='FAIL' and (any(x['result']=='FAIL' for x in d['buildReads']) or any(x.get('errorCode') for x in d['resultReadObservations']) or any(x['result']=='FAIL' for x in d['preStartReads']))

wrapper=read('sample.json.gate.json');assert wrapper['gate']=='PASS' and wrapper['checks']==115 and len(child['checks'])==123 and wrapper['cleanup']=='PASS'
assert wrapper['parentCleanupObservation']['gate']=='PASS' and wrapper['parentCleanupObservation']['operations']==13
empty=read('database-empty-audit.json');assert empty['gate']=='PASS' and empty['result']['prefix']==child['prefix'] and empty['result']['action']=='audit-empty'
for n in ['collect-correlations.closure.exit','finish-unit.pipeline.exit']:
 assert int((p/n).read_text())==1;bindings[n]=hashlib.sha256((p/n).read_bytes()).hexdigest()
for n in ['sampling-patch.json','sampling-patch-recovered.json']:
 v=read(n);assert v['gate']=='PARTIAL' and v['logReadErrors']=={'lambda':'LOG_READ_TIMEOUT'} and v['exactLinkedCount']==0 and len(v['records'])==12
assert read('baseline-patch.json')['gate']=='PASS' and read('baseline-audit.json')['gate']=='PASS' and read('sampling-audit.json')['gate']=='PASS'
for n in ['deployment-input-binding.json','actual-config.json','application-version.json','artifact-transition.json','renewable-session-gate.json']:
 assert read(n)['gate']=='PASS'
for n in ['collect-correlations.closure.stderr.log','log-read-recovery.command.json','log-read-recovery.exit','log-read-recovery.stderr.log','finish-unit.pipeline.stderr.log']:
 bindings[n]=hashlib.sha256((p/n).read_bytes()).hexdigest()
v={'gate':'PASS','scope':'ORIGINAL_R1_BUSINESS_AND_CLEANUP_ONLY_AFTER_FAILED_LOG_COLLECTION','stageGate':'FAIL','logCollectionGate':'FAIL','logReadRecoveryGate':'FAIL','sourceCommit':child['sourceCommit'],'prefix':child['prefix'],'businessGate':'PASS','businessChecks':123,'parentChecks':115,'cleanup':'PASS','cleanupRecovery':False,'independentEmptyAudit':'PASS','error':'LOG_READ_TIMEOUT','extraSamples':0,'bindings':bindings,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fullQa09Accepted':False,'p95Accepted':False}
out.write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({k:x for k,x in v.items() if k!='bindings'}))
