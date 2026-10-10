import os,subprocess,json,ast,datetime
from pathlib import Path
root=Path(__file__).parent;sha='b5522378aebca9340a0767b53ed3bab846ffc080';run='38006504921'
env={**os.environ,'PATH':'/Users/anray/.nvm/versions/node/v24.12.0/bin:'+os.environ['PATH'],'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 p=root/'preflight';assert not (p/(name+'.exit')).exists()
 (p/(name+'.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:q=subprocess.run(args,env=env,stdout=o,stderr=e)
 (p/(name+'.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
call('ci',['gh','run','view','38006504899','--json','headSha,status,conclusion,url'])
x=json.loads((root/'preflight/ci.stdout.log').read_text());assert x['headSha']==sha and x['status']=='completed' and x['conclusion']=='success';(root/'preflight/ci-run.json').write_text(json.dumps(x,indent=2)+'\n')
call('default-binding',['python3',str(root/'bind-unit-deployment.py'),'default-off',run])
call('default-19',['node','scripts/collect-qa09-application-version.mjs',str(root/'default-off/application-version.json')])
call('default-config',['node','scripts/qa09-account-read-config.mjs',str(root/'default-off/qa09-deployment-inputs.json'),str(root/'default-off/application-version.json'),str(root/'default-off/actual-config.json')])
