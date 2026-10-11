"""Offline negative tests of the actual restoration entry helpers; no AWS/GitHub calls."""
from pathlib import Path
import hashlib,json,os,subprocess,tempfile
root=Path(__file__).resolve().parent;out=root/'preflight/failed-stage-restore-negative-matrix.json';assert not out.exists()
sha='41ee358fb92e4dae2ae4abba7eb9923996fe029b';rows=[];sources={}
for helper,args in [('dispatch-restore-after-r1-stage-failure.py',['restore','--cleanup-only-r1']),('run-restore-after-r1-stage-failure.py',['123','--cleanup-only-r1'])]:
 raw=(root/helper).read_bytes();sources[helper]=hashlib.sha256(raw).hexdigest()
 for name,changes in [('stage-not-failed',{'stageGate':'PASS'}),('cleanup-failed',{'cleanup':'FAIL'}),('empty-not-proven',{'independentEmptyAudit':'FAIL'}),('retry-not-failed',{'logReadRecoveryGate':'PASS'}),('bound-bytes-drift',{}),('wrong-source',{'sourceCommit':'0'*40})]:
  with tempfile.TemporaryDirectory(prefix='qa09-restore-negative-',dir='/tmp') as tmp:
   p=Path(tmp);(p/'r1').mkdir();(p/'restore').mkdir();(p/'bin').mkdir();(p/helper).write_bytes(raw)
   value={'gate':'PASS','sourceCommit':sha,'stageGate':'FAIL','cleanup':'PASS','logReadRecoveryGate':'FAIL','independentEmptyAudit':'PASS','bindings':{}}
   value.update(changes)
   if name=='bound-bytes-drift':
    (p/'r1/bound.txt').write_text('changed');value['bindings']={'bound.txt':hashlib.sha256(b'original').hexdigest()}
   (p/'r1/cleanup-only-completion.json').write_text(json.dumps(value))
   marker=p/'EXTERNAL_CALLED';stub='#!/bin/sh\n: > '+str(marker)+'\nexit 99\n'
   for tool in ['gh','aws']:
    x=p/'bin'/tool;x.write_text(stub);x.chmod(0o700)
   q=subprocess.run(['python3',str(p/helper),*args],capture_output=True,text=True,env={**os.environ,'PATH':str(p/'bin')+':'+os.environ['PATH']},timeout=10)
   assert q.returncode!=0 and not marker.exists() and not list((p/'restore').iterdir()),(helper,name)
   rows.append({'helper':helper,'case':name,'result':'PASS','exit':q.returncode,'externalCalls':0,'restoreFiles':0})
v={'gate':'PASS','scope':'OFFLINE_ACTUAL_RESTORE_HELPER_FAIL_CLOSED_MATRIX','cases':rows,'sourceHashes':sources,'tests':len(rows),'networkCalls':0,'cloudMutations':0,'p95Accepted':False,'fullQa09Accepted':False}
out.write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({'gate':'PASS','tests':len(rows),'networkCalls':0,'cloudMutations':0}))
