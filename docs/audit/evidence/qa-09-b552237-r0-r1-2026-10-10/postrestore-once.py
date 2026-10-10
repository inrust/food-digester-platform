"""Wait for byte-bound restoration, then perform one read-only closure; no business fixtures."""
from pathlib import Path
import subprocess,json,time,os
root=Path(__file__).parent;p=root/'restore';start=time.monotonic()
print('Waiting for original same-SHA restore completion; no new business fixtures.',flush=True)
while not (p/'restore-completion.json').exists():
 for f in p.glob('*.pipeline.exit'):
  assert int(f.read_text())==0,'RESTORE_PIPELINE_FAILURE_REQUIRES_EXACT_EXISTING_RUN_DIAGNOSTIC'
 assert time.monotonic()-start<2700,'RESTORE_WAIT_BUDGET_EXHAUSTED_NO_REDISPATCH'
 time.sleep(10)
def call(name,args):
 assert not (p/(name+'.final.exit')).exists(),'NO_FINAL_STEP_REPLAY'
 (p/(name+'.final.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.final.stdout.log')).open('w') as o,(p/(name+'.final.stderr.log')).open('w') as e:q=subprocess.run(args,stdout=o,stderr=e,env={**os.environ,'PATH':'/Users/anray/.nvm/versions/node/v24.12.0/bin:'+os.environ['PATH']})
 (p/(name+'.final.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
call('post-restoration-readonly',['python3',str(root/'finish-restoration-readonly.py')])
call('recovered-owned-domain',['node',str(root/'verify-restored-recovered-domain.mjs')])
call('owned-build-terminal',['python3',str(root/'verify-owned-build-terminal-bounded.py')])
