"""Fresh default-off artifact/config reads, no business fixture or deployment dispatch."""
import os,subprocess,json
from pathlib import Path
root=Path(__file__).parent;sha='5773ac9d7bad13d41c2d00e456f8b633fa939579';run='38122155867'
p=root/'preflight';(root/'default-off').mkdir(exist_ok=True)
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 assert not (p/(name+'.exit')).exists(),'NO_STEP_REPLAY'
 (p/(name+'.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:q=subprocess.run(args,env=env,stdout=o,stderr=e)
 (p/(name+'.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
call('default-binding',['python3',str(root/'bind-unit-deployment.py'),'default-off',run])
call('default-hosted',['python3',str(root/'collect-hosted-verify.py'),'default-off',run])
call('default-19',['node','scripts/collect-qa09-application-version.mjs',str(root/'default-off/application-version.json')])
call('default-config',['node','scripts/qa09-account-read-config.mjs',str(root/'default-off/qa09-deployment-inputs.json'),str(root/'default-off/application-version.json'),str(root/'default-off/actual-config.json')])
