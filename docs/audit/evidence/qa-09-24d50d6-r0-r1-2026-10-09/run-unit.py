"""One sequential same-SHA unit; no business replay, parent runner owns finally cleanup."""
import os,sys,json,hashlib,shutil,subprocess
from pathlib import Path
root=Path(__file__).parent;mode,run=sys.argv[1:3];resume=sys.argv[3:]==['--resume-prebusiness'];assert len(sys.argv)==(4 if resume else 3);assert mode in ['r0','r1'];p=root/mode
sha='24d50d6c3a9000c629d8255f78ea8d57a9d5b3f7';source=root/('default-off' if mode=='r0' else 'r0')/'application-version.json'
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
 assert int((p/'wait-success.pipeline.exit').read_text())!=0 and 'TLS handshake timeout' in (p/'wait-success.pipeline.stderr.log').read_text(),'READ_ONLY_WAIT_NETWORK_FAILURE_REQUIRED'
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
