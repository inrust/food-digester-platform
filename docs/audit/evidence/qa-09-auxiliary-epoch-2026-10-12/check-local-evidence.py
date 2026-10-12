"""Validate local format repair logs and replay provenance; never calls AWS."""
from pathlib import Path
import hashlib,json,ast
root=Path(__file__).resolve().parent;repo=root.parents[3];h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for name,count in [('targeted-final',134),('test-scripts',1263)]:
 assert (root/(name+'.exit')).read_text().strip()=='0'
 text=(root/(name+'.stdout.log')).read_text();assert 'tests '+str(count)+'\n' in text and 'pass '+str(count)+'\n' in text and 'fail 0\n' in text
for name in ['lint','format-check','secrets']:assert (root/(name+'.exit')).read_text().strip()=='0'
cases=list((root/'cases-final').glob('*.json'));assert len(cases)==88
for p in cases:
 v=json.loads(p.read_bytes());assert v['gate']=='PASS' and v['awsCalls']==0 and v['collectorSha256']==h(repo/'scripts/collect-qa09-auxiliary-phases.py')
before=json.loads((root/'before/replay.json').read_bytes());assert before['resultGate']=='PARTIAL' and before['error']=='AUX_GATEWAY_TIME_MISMATCH' and before['records']==0 and before['awsCalls']==0
assert before['collectorSha256']==h(root/'collect-qa09-auxiliary-phases.py.before.txt')
assert int((root/'before-checker/exit').read_text())!=0
for name,count,calls in [('after',12,16),('after-initial',8,18)]:
 v=json.loads((root/name/'replay.json').read_bytes());a=json.loads((root/name/'aux.json').read_bytes());c=json.loads((root/name/'checker.json').read_bytes())
 assert v['resultGate']==a['gate']==c['gate']=='PASS' and v['records']==count and v['simulatedCliCalls']==calls and v['awsCalls']==0 and v['businessRequests']==0
 assert v['collectorSha256']==h(repo/'scripts/collect-qa09-auxiliary-phases.py')
 assert all(isinstance(row['gateway'][0]['requestTimeEpoch'],str) for row in a['records'])
 for n,digest in v['historicalBindings'].items():assert h(repo/n)==digest
paths=['scripts/collect-qa09-auxiliary-phases.py','scripts/check-qa09-auxiliary-read.mjs','scripts/qa09_auxiliary_read_test_driver.py','scripts/qa09-auxiliary-read.test.mjs','scripts/check-qa09-auxiliary-read.test.mjs']
for n in paths:
 if n.endswith('.py'):ast.parse((repo/n).read_bytes())
print(json.dumps({'gate':'LOCAL_GATEWAY_EPOCH_COMPATIBILITY_PASS','scope':'OFFLINE_FORMAT_INPUTS_REPLAY_AND_STORED_TEST_LOGS_ONLY','baseCommit':'f7f996f278877cb57fc9d400f8f1d24b6ff5ff48','targetedTests':134,'allScriptTests':1263,'caseReceipts':88,'awsCalls':0,'businessRequests':0,'bindings':{n:h(repo/n) for n in paths},'newTargetR0R1':'NOT_RUN','fullQa09Accepted':False,'p95Accepted':False}))
