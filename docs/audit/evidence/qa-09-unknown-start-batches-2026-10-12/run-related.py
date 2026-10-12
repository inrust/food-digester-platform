from pathlib import Path
import subprocess,json,os
root=Path(__file__).resolve().parent
cmd=['node','--test','scripts/qa09-cleanup-recovery.test.mjs','scripts/qa09-cognito-observation.test.mjs']
name='recovery-cognito';assert not (root/(name+'.exit')).exists()
(root/(name+'.command.json')).write_text(json.dumps(cmd)+'\n')
with (root/(name+'.stdout.log')).open('w') as out,(root/(name+'.stderr.log')).open('w') as err:
 p=subprocess.run(cmd,env=dict(os.environ,PATH='/Users/anray/.nvm/versions/node/v24.12.0/bin:'+os.environ['PATH']),stdout=out,stderr=err)
(root/(name+'.exit')).write_text(str(p.returncode)+'\n');print(p.returncode)
