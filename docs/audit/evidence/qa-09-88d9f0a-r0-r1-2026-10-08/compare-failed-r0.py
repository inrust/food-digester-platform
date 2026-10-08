"""Final disposition after R0 owned cleanup, failed strict stages and default-off restoration."""
import json,hashlib
from pathlib import Path
root=Path(__file__).parent;bindings={}
def read(n):
 b=(root/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
cleanup=read('r0/cleanup-only-completion.json');assert cleanup['gate']=='PASS' and cleanup['stageGate']=='FAIL'
for n,h in cleanup['bindings'].items():assert hashlib.sha256((root/'r0'/n).read_bytes()).hexdigest()==h
restore=read('restore/post-restoration-readonly.json');assert restore['gate']=='PASS' and restore['sourceCommit']==cleanup['sourceCommit']
for n,h in restore['bindings'].items():assert hashlib.sha256((root/'restore'/n).read_bytes()).hexdigest()==h
failed=read('client-split-diagnosis.json');assert failed['gate']=='FAIL' and failed['requests']==55 and failed['failed']==3 and failed['toleranceMs']==5 and failed['toleranceChanged'] is False
for n,h in failed['bindings'].items():assert hashlib.sha256((root/'r0'/n).read_bytes()).hexdigest()==h
assert not (root/'r1/dispatch.exit').exists() and not (root/'r1/sample.json').exists(),'R1_NOT_RUN_REQUIRED'
observed=read('stage-observations.json');assert len(observed['physicalCold409'])==2
out={'gate':'PARTIAL','scope':'R0_BUSINESS_CLEANUP_CLOSED_STRICT_SPLIT_FAIL_R1_NOT_RUN_AND_DEFAULT_OFF_RESTORED','sourceCommit':cleanup['sourceCommit'],'r0BusinessGate':'PASS','r0CleanupGate':'PASS','r0ExactRequests':55,'negativeRequests':12,'r0StrictStageGate':'FAIL','correctedBaselinePhaseGate':'PASS','correctedSamplingPhaseGate':'FAIL','failedSplitRequests':3,'r1Gate':'NOT_RUN','matchedNaturalColdGate':'NOT_RUN','restoreGate':'PASS','freshRestoreReadOnlyAuditGate':'PASS','candidateBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'bindings':bindings}
(root/'comparison.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k!='bindings'}))
