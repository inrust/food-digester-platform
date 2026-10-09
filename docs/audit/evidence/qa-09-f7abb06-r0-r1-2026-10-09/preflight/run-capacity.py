import os,subprocess,json
from pathlib import Path
root=Path(__file__).parent.parent;p=root/'preflight';env={**os.environ,'PATH':'/Users/anray/.nvm/versions/node/v24.12.0/bin:'+os.environ['PATH']}
assert not (p/'capacity-before.json').exists()
for name,args in [('capacity',['node',str(root/'capacity-readonly.mjs'),str(p/'capacity-before.json')]),('capacity-gate',['python3',str(root/'capacity-gate.py'),str(p)])]:
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:q=subprocess.run(args,env=env,stdout=o,stderr=e)
 (p/(name+'.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0
