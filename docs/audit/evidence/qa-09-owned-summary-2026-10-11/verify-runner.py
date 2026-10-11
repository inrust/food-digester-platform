import json,subprocess,time,os
from pathlib import Path
root=Path('docs/audit/evidence/qa-09-owned-summary-2026-10-11')
original=json.loads(Path('package.json').read_text())['scripts']['verify'].split(' && ')
ignore=Path('.qa09-owned-prettierignore');ignore.write_text('build/\n')
commands=original.copy();commands[0]="pnpm exec eslint . --ignore-pattern 'build/**'";commands[1]='pnpm exec prettier --check . --ignore-path .prettierignore --ignore-path .gitignore --ignore-path .qa09-owned-prettierignore'
plan={'scope':'VERIFY_EQUIVALENT_ONLY_LINT_FORMAT_EXCLUDE_PREEXISTING_UNTRACKED_BUILD','noCloudActions':True,'exclusions':['build/ (lint and format only)'],'commands':[]}
for i,(orig,cmd) in enumerate(zip(original,commands)):
    start=time.monotonic()
    with (root/f'verify-{i+1:02d}.log').open('w') as log:
        proc=subprocess.run(cmd,shell=True,stdout=log,stderr=subprocess.STDOUT,timeout=1800)
    row={'index':i+1,'original':orig,'command':cmd,'exitCode':proc.returncode,'elapsedSeconds':round(time.monotonic()-start,3),'log':f'verify-{i+1:02d}.log'}
    plan['commands'].append(row);(root/'verify-results.json').write_text(json.dumps(plan,indent=2)+'\n');print(json.dumps(row),flush=True)
    if proc.returncode:raise SystemExit(proc.returncode)
