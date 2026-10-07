"""Wait read-only, bind success/source/bytes, then execute exactly the approved 12 GETs."""
import subprocess,json,time,concurrent.futures
from pathlib import Path
p=Path(__file__).parent
root=p.parent
run_id='37563191928'
sha='9e4143b5144a8aa10692927084256c225d5dd6d4'
while True:
 q=subprocess.run(['gh','run','view',run_id,'--json','databaseId,status,conclusion,headSha,event,jobs,url'],capture_output=True,text=True)
 assert q.returncode==0,q.stderr
 x=json.loads(q.stdout)
 assert x['headSha']==sha and x['event']=='workflow_dispatch'
 if x['status']=='completed':
  (p/'deploy-run.json').write_text(q.stdout)
  assert x['conclusion']=='success','DEPLOY_FAILED_NO_PROBES'
  break
 time.sleep(30)
print('deploy success; starting bounded version/input read',flush=True)
def call(name,cmd):
 (p/(name+'.command.json')).write_text(json.dumps(cmd,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:
  code=subprocess.run(cmd,stdout=o,stderr=e).returncode
 (p/(name+'.exit')).write_text(str(code)+'\n')
 print(name,code,flush=True)
 return code
jobs=[('bind-deployment',['python3',str(root/'bind-unit-deployment.py'),'on',run_id]),('version-collect',['node','scripts/collect-qa09-application-version.mjs',str(p/'application-version.json')]),('cdk-diff',['python3',str(root/'collect-cdk-diff.py'),'on',run_id])]
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
 codes=list(ex.map(lambda j:call(*j),jobs))
assert codes==[0,0,0],'READ_BIND_FAILED_NO_PROBES'
assert json.loads((p/'application-version.json').read_text())['gate']=='PASS'
assert json.loads((p/'deployment-input-binding.json').read_text())['gate']=='PASS'
assert not (p/'negative-get.json').exists(),'NO_DUPLICATE_NEGATIVE_PROBES'
for name,cmd in [('negative-client',['node',str(p/'negative-get.mjs')]),('negative-collect',['python3',str(p/'collect-negative-phases.py')]),('negative-check',['node',str(p/'check-negative.mjs')])]:
 assert call(name,cmd)==0
print('ON_VERSION_INPUT_NEGATIVE_PASS_NO_FIXTURE_CREATED',flush=True)
