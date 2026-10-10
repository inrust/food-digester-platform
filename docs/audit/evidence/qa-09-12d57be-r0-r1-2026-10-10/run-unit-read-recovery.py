"""One sequential same-SHA unit; no business replay, parent runner owns finally cleanup."""
import os,sys,json,hashlib,shutil,subprocess
from pathlib import Path
root=Path(__file__).parent;mode,run=sys.argv[1:3];resume=sys.argv[3:]==['--resume-prebusiness'];assert len(sys.argv)==(4 if resume else 3);assert mode in ['r0','r1'];p=root/mode
sha='12d57befe55be1e1abfd1e226c2d13cbace992dc';source=root/('default-off' if mode=='r0' else 'r0')/'application-version.json'
assert not (p/'sample.json').exists() and not (p/'business-window.json').exists(),'NO_BUSINESS_REPLAY'
if mode=='r1':
 closure=json.loads((root/'r0/unit-completion.json').read_text());assert closure['gate']=='PASS' and closure['sourceCommit']==sha
 for n,h in closure['bindings'].items():assert hashlib.sha256((root/'r0'/n).read_bytes()).hexdigest()==h
else:
 assert json.loads((root/'default-off/actual-config.json').read_text())['gate']=='PASS'
 assert json.loads((root/'preflight/capacity-before-gate.json').read_text())['gate']=='PASS'
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 assert not (p/(name+'.pipeline.exit')).exists(),'NO_REPLAY_STEP'
 (p/(name+'.pipeline.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.pipeline.stdout.log')).open('w') as o,(p/(name+'.pipeline.stderr.log')).open('w') as e:q=subprocess.run(args,env=env,stdout=o,stderr=e)
 (p/(name+'.pipeline.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
if resume:
 assert int((p/'wait-success.pipeline.exit').read_text())!=0, 'ORIGINAL_READ_FAILURE_REQUIRED'
 error=(p/'wait-success.pipeline.stderr.log').read_text()
 assert 'TLS handshake timeout' in error or ('read: operation timed out' in error and '/actions/runs/'+run in error), 'EXACT_KNOWN_RUN_NETWORK_READ_FAILURE_ONLY'
 assert (p/'recover-wait-status.step.exit').read_text().strip()=='0'
 current=json.loads((p/'recover-wait-status.step.stdout.log').read_text())
 assert current['headSha']==sha and (current['status'] in ['queued','in_progress'] or current['conclusion']=='success'), 'ORIGINAL_FAILED_WORKFLOW_NOT_RECOVERABLE'
 dispatch=json.loads((p/'dispatch-run.json').read_text());assert str(dispatch['databaseId'])==run and dispatch['sourceCommit']==sha and (p/'dispatch.exit').read_text().strip()=='0'
 files=['wait-success.pipeline.exit','wait-success.pipeline.stderr.log','recover-wait-status.step.stdout.log','recover-wait-status.step.exit','dispatch-run.json','dispatch.exit']
 assert not (p/'wait-read-recovery.json').exists()
 (p/'wait-read-recovery.json').write_text(json.dumps({'gate':'READY','scope':'EXACT_EXISTING_GITHUB_RUN_READ_ONLY_RECOVERY_ENTRY_NOT_WORKFLOW_SUCCESS','sourceCommit':sha,'runId':run,'originalReadGate':'FAIL','originalWorkflowFailure':False,'maximumNewWaits':1,'newDispatches':0,'businessStarted':False,'bindings':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in files}},indent=2)+'\n')
 assert not (p/'bind-deployment.pipeline.exit').exists(),'NO_COMPLETED_STEP_REPLAY'
 call('wait-success-recovery',['gh','run','watch',run,'--exit-status','--interval','30'])
else:call('wait-success',['gh','run','watch',run,'--exit-status','--interval','30'])
call('bind-deployment',['python3',str(root/'bind-unit-deployment.py'),mode,run])
call('cdk-diff',['python3',str(root/'collect-cdk-diff.py'),mode,run])
call('hosted-verify',['python3',str(root/'collect-hosted-verify.py'),mode,run])
assert not (p/'application-version.json').exists();shutil.copyfile(source,p/'application-version.json')
(p/'artifact-reuse-origin.json').write_text(json.dumps({'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'SAME_SHA_ZIP_BYTES_REUSE_ONLY_FRESH_19_CONFIGS'},indent=2)+'\n')
call('19-artifacts',['node','scripts/collect-qa09-application-version.mjs',str(p/'application-version.json'),'--retry-unverified'])
call('actual-config',['node','scripts/qa09-account-read-config.mjs',str(p/'qa09-deployment-inputs.json'),str(p/'application-version.json'),str(p/'actual-config.json')])
call('capacity',['node',str(root/'capacity-readonly.mjs'),str(p/'capacity-before.json')])
call('capacity-gate',['python3',str(root/'capacity-gate.py'),str(p)])
call('renewable-session',['python3',str(root/'await-renewable-session.py'),mode])
call('business',['python3',str(root/'run-business.py'),str(p)])
call('finish-unit',['python3',str(root/'finish-unit.py'),mode])
