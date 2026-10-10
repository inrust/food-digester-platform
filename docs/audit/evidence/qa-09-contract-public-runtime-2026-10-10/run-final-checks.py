"""Affected local checks after cost-location assertions; no AWS or business requests."""
from pathlib import Path
import json,os,subprocess,time
root=Path(__file__).resolve().parent
repo=root.parents[3]
env=dict(os.environ);env['PATH']='/Users/anray/.nvm/versions/node/v24.12.0/bin:'+env['PATH']
steps=[
 ('final-focused-app',['pnpm','exec','vitest','run','packages/database/test/contract-public-runtime.test.ts','packages/database/test/contract-public-ownership.test.ts','packages/database/test/contract-load-detail.test.ts','apps/cloud-api/test/admin-engine-diagnostic.test.ts','apps/cloud-api/test/admin-runtime-initialization.test.ts']),
 ('final-focused-scripts',['node','--test','scripts/qa09-contract-public-proof.test.mjs','scripts/qa09-deployment-inputs.test.mjs','scripts/qa09-account-read-config.test.mjs','scripts/qa09-exact-correlation.test.mjs']),
 ('final-database-types',['pnpm','--filter','@fdp/database','typecheck']),
 ('final-lint',['pnpm','exec','eslint','.','--ignore-pattern','build/']),
 ('final-format',['pnpm','exec','prettier','--check','.','!build/**']),
 ('final-diff',['git','diff','--check']),
 ('final-secrets',['pnpm','check:secrets']),
]
assert not (root/'final-checks.json').exists();results=[]
for name,args in steps:
 assert not (root/(name+'.command.json')).exists()
 (root/(name+'.command.json')).write_text(json.dumps({'args':args,'scope':'LOCAL_ONLY'},indent=2)+'\n')
 started=time.monotonic()
 with (root/(name+'.stdout.log')).open('w') as out,(root/(name+'.stderr.log')).open('w') as err:
  run=subprocess.run(args,cwd=repo,env=env,stdout=out,stderr=err)
 row={'name':name,'exitCode':run.returncode,'durationSeconds':round(time.monotonic()-started,3)};results.append(row)
 (root/(name+'.exit')).write_text(str(run.returncode)+'\n');print(json.dumps(row),flush=True)
 if run.returncode:
  (root/'final-checks.json').write_text(json.dumps({'gate':'FAIL','results':results},indent=2)+'\n');raise SystemExit(run.returncode)
(root/'final-checks.json').write_text(json.dumps({'gate':'PASS','scope':'FINAL_AFFECTED_LOCAL_ONLY','results':results,'targetGate':'NOT_RUN','p95Accepted':False},indent=2)+'\n')
