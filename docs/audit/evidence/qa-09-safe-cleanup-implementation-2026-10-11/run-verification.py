"""Run package.json verification in order; only preserve/exclude the pre-existing untracked build output."""
from pathlib import Path
import datetime,json,subprocess,shlex
root=Path(__file__).resolve().parent
plan=json.loads((root/'verify-plan.json').read_text());out=root/'verify-results.json';assert not out.exists()
rows=[]
def save():out.write_text(json.dumps(dict(gate='RUNNING',scope=plan['scope'],steps=rows),indent=2)+'\n')
for i,command in enumerate(plan['commands'],1):
 row=dict(step=i,command=command,startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),gate='RUNNING');rows.append(row);save()
 log=root/f'verify-{i:02}.log';assert not log.exists()
 with log.open('w') as stream:q=subprocess.run(shlex.split(command),stdout=stream,stderr=subprocess.STDOUT)
 row.update(exit=q.returncode,gate='PASS' if q.returncode==0 else 'FAIL',finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),log=log.name);save()
 print(json.dumps(dict(step=i,exit=q.returncode,command=command)),flush=True)
 if q.returncode:raise SystemExit(q.returncode)
out.write_text(json.dumps(dict(gate='PASS',scope=plan['scope'],steps=rows,cloudActions=0,targetAcceptance=False),indent=2)+'\n')
