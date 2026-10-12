"""Recheck stored offline cases and original test logs; no AWS or business calls."""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parent;repo=root.parents[3]
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
sources=['scripts/collect-qa09-auxiliary-phases.py','scripts/check-qa09-auxiliary-read.mjs','scripts/qa09_auxiliary_read_test_driver.py','scripts/qa09-auxiliary-read.test.mjs','scripts/check-qa09-auxiliary-read.test.mjs','scripts/qa09_log_read.py']
for name,count in [('targeted-final',88),('test-scripts-final',1217)]:
 assert (root/(name+'.exit')).read_text().strip()=='0'
 text=(root/(name+'.stdout.log')).read_text()
 assert 'tests '+str(count)+'\n' in text and 'pass '+str(count)+'\n' in text and 'fail 0\n' in text
for name in ['lint-final','format-final','secrets-final']:
 assert (root/(name+'.exit')).read_text().strip()=='0'
cases=sorted((root/'cases-final').glob('*.json'));assert len(cases)==59
for p in cases:
 v=json.loads(p.read_bytes());assert v['gate']=='PASS' and v['awsCalls']==0
 assert v['collectorSha256']==digest(repo/sources[0]),p.name
for name,count in [('initial-complete',18),('negative-complete',24),('negative-rejected',16)]:
 v=json.loads((root/('proof-'+name)/'checker.json').read_bytes());assert v['gate']=='PASS'
proof=json.loads((root/'direct-entry-proof.json').read_bytes());assert proof['gate']=='PASS'
assert proof['readerSha256']==digest(repo/'scripts/qa09_log_read.py')
result={'gate':'LOCAL_AUXILIARY_BATCH_CANDIDATE_PASS','scope':'STORED_CONTROLLED_CASES_AND_LOCAL_TEST_LOGS_ONLY','baseCommit':'ebbcfc0ee31673b3332b217ca757e6aa1ea6013d','focusedTests':88,'allScriptTests':1217,'controlledCaseReceipts':59,'awsCalls':0,'bindings':{n:digest(repo/n) for n in sources},'targetCi':'NOT_RUN','targetDeployment':'NOT_RUN','targetR0R1':'NOT_RUN','fullQa09Accepted':False,'p95Accepted':False}
if '--write' in sys.argv:
 with (root/'local-evidence-check.json').open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
