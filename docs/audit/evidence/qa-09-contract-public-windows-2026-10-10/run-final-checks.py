"""Final affected checks after adding the explicit same-Pool identity assertion; local only."""
from pathlib import Path
import os, json, subprocess, time
root = Path(__file__).resolve().parent
repo = root.parents[3]
env = dict(os.environ)
env['PATH'] = '/Users/anray/.nvm/versions/node/v24.12.0/bin:' + env['PATH']
sources = [
 'scripts/qa09-contract-windows-proof.mjs', 'scripts/qa09-contract-windows-proof.test.mjs',
 'scripts/run-qa09-contract-windows-offline.mjs', 'scripts/qa09-contract-windows-proof.d.mts',
 'packages/database/test/contract-windows-offline.test.ts', 'packages/database/test/contract-window-probe.test.ts',
 'packages/database/test/helpers/contract-window-probe.ts',
]
steps = [
 ('final-focused',['pnpm','exec','vitest','run','packages/database/test/contract-windows-offline.test.ts','packages/database/test/contract-window-probe.test.ts','packages/database/test/contract-load-detail.test.ts']),
 ('final-typecheck',['pnpm','--filter','@fdp/database','typecheck']),
 ('final-lint',['pnpm','exec','eslint'] + sources),
 ('final-format',['pnpm','exec','prettier','--check'] + sources),
 ('final-scripts',['pnpm','test:scripts']),
 ('final-diff',['git','diff','--check']),
]
assert not (root/'final-checks.json').exists()
results=[]
for name,args in steps:
 (root/(name+'.command.json')).write_text(json.dumps({'args':args,'scope':'LOCAL_ONLY'},indent=2)+'\n')
 started=time.monotonic()
 with (root/(name+'.stdout.log')).open('w') as out, (root/(name+'.stderr.log')).open('w') as err:
  run=subprocess.run(args,cwd=repo,env=env,stdout=out,stderr=err)
 row={'name':name,'exitCode':run.returncode,'durationSeconds':round(time.monotonic()-started,3)}
 results.append(row);(root/(name+'.exit')).write_text(str(run.returncode)+'\n');print(json.dumps(row),flush=True)
 if run.returncode: break
(root/'final-checks.json').write_text(json.dumps({'gate':'PASS' if all(r['exitCode']==0 for r in results) and len(results)==len(steps) else 'FAIL','scope':'FINAL_AFFECTED_LOCAL_CHECKS','results':results,'targetGate':'NOT_RUN'},indent=2)+'\n')
raise SystemExit(0 if all(r['exitCode']==0 for r in results) else 1)
