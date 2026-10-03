import os,json,subprocess,sys
from pathlib import Path
values=json.loads(Path('docs/audit/evidence/qa-09-phased-deployment-2026-10-03/github-vars.json').read_text())
env={**os.environ,**{x['name']:x['value'] for x in values},'FDP_QA09_ROLLOUT_PHASE':sys.argv[1],'PATH':'/Users/anray/.nvm/versions/node/v24.12.0/bin:'+os.environ['PATH']}
r=subprocess.run(['node','scripts/esgiot-cdk.mjs',sys.argv[2],'AppDependencies'],env=env)
sys.exit(r.returncode)
