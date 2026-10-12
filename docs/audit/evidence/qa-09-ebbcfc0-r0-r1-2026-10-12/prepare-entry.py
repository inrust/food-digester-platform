"""One fresh capacity-only Plan after default-off artifact/config gates."""
import json,subprocess,os
from pathlib import Path
root=Path(__file__).parent;p=root/'preflight'
assert json.loads((root/'default-off/application-version-after-ci.json').read_text())['gate']=='PASS'
assert json.loads((root/'default-off/actual-config.json').read_text())['gate']=='PASS'
def call(name,args):
 assert not (p/(name+'.entry.exit')).exists(),'NO_STEP_REPLAY'
 (p/(name+'.entry.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.entry.stdout.log')).open('w') as o,(p/(name+'.entry.stderr.log')).open('w') as e:q=subprocess.run(args,stdout=o,stderr=e)
 (p/(name+'.entry.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
call('capacity',['node',str(root/'capacity-readonly.mjs'),str(p/'capacity-before.json')])
call('capacity-gate',['python3',str(root/'capacity-gate.py'),str(p)])
call('prestart-entry',['node',str(root/'check-prestart-entry.mjs'),'preflight'])
call('renewable-session',['python3',str(root/'await-renewable-session.py'),'preflight'])
call('close-entry',['python3',str(root/'close-entry.py')])
