"""Reuse strict original cleanup/source ownership checks, bind this round's failure."""
import ast, hashlib, json, subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
origin=root.parent/'qa-09-41ee358f-r0-r1-2026-10-11/complete-r1-cleanup-only.py'
target=root/'complete-r0-cleanup-only.py';assert not target.exists()
head=origin.read_text().split("wrapper=read('sample.json.gate.json')",1)[0].replace("p=root/'r1'","p=root/'r0'")
tail="""wrapper=read('sample.json.gate.json');assert wrapper['gate']=='PASS' and wrapper['checks']==115 and len(child['checks'])==123 and wrapper['cleanup']=='PASS'
assert wrapper['parentCleanupObservation']['gate']=='PASS' and wrapper['parentCleanupObservation']['operations']==13
empty=read('database-empty-audit.json');assert empty['gate']=='PASS' and empty['result']['prefix']==child['prefix'] and empty['result']['action']=='audit-empty'
assert read('negative-get.json')['gate']=='PASS'
for name in ['baseline-patch','baseline-audit','sampling-patch','sampling-audit']:
 assert read(name+'.json')['gate']=='PASS'
 assert read(name+'-budget.stdout.log')['gate']=='PASS'
failure=read('initial-phases.json');assert failure['gate']=='PARTIAL' and failure['logReadBudget']['error']=='LOG_CALL_LIMIT' and len(failure['logReadBudget']['attempts'])==40 and len(failure['records'])==6
for n in ['finish-unit.pipeline.exit','collect-initial.closure.exit','collect-initial-recovery.closure.exit','local-import-recovery.exit']:
 assert (p/n).read_text().strip()=='1';bindings[n]=hashlib.sha256((p/n).read_bytes()).hexdigest()
for n in ['collect-initial.closure.stderr.log','collect-initial-recovery.closure.stderr.log','local-import-recovery.stderr.log','finish-unit.pipeline.stderr.log']:
 bindings[n]=hashlib.sha256((p/n).read_bytes()).hexdigest()
for n in ['deployment-input-binding.json','actual-config.json','application-version.json','renewable-session-gate.json']:
 assert read(n)['gate']=='PASS'
assert not (root/'r1/dispatch.exit').exists() and not (p/'unit-completion.json').exists()
v={'gate':'PASS','scope':'ORIGINAL_R0_BUSINESS_AND_CLEANUP_ONLY_AFTER_AUXILIARY_CALL_LIMIT','stageGate':'FAIL','logCollectionGate':'PARTIAL','sourceCommit':child['sourceCommit'],'prefix':child['prefix'],'businessGate':'PASS','businessChecks':123,'parentChecks':115,'cleanup':'PASS','cleanupRecovery':False,'independentEmptyAudit':'PASS','error':'LOG_CALL_LIMIT','initialRowsComplete':6,'initialRowsRequired':8,'mainPhaseRequests':55,'r1Gate':'NOT_RUN','restoreRequired':True,'businessReplays':0,'extraSamples':0,'bindings':bindings,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fullQa09Accepted':False,'p95Accepted':False}
out.write_text(json.dumps(v,indent=2)+'\\n');print(json.dumps({k:x for k,x in v.items() if k!='bindings'}))
"""
text=head+tail;ast.parse(text);target.write_text(text)
proof={'origin':str(origin),'originSha256':hashlib.sha256(origin.read_bytes()).hexdigest(),'path':str(target),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'scope':'STRICT_ORIGINAL_CLEANUP_CHECKS_AND_THIS_FAILED_R0_ONLY'}
(root/'preflight/failed-r0-cleanup-proof-origin.json').write_text(json.dumps(proof,indent=2)+'\n')
subprocess.run(['python3',str(target)],check=True)
