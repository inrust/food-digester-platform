"""One exact CI attempt wait; no rerun or deploy dispatch."""
from pathlib import Path
import subprocess,json
p=Path(__file__).parent;assert not (p/'ci-wait.exit').exists()
args=['gh','run','watch','38122155900','--exit-status','--interval','30']
(p/'ci-wait.command.json').write_text(json.dumps(args)+'\n')
with (p/'ci-wait.stdout.log').open('w') as o,(p/'ci-wait.stderr.log').open('w') as e:q=subprocess.run(args,stdout=o,stderr=e)
(p/'ci-wait.exit').write_text(str(q.returncode)+'\n');assert q.returncode==0
q=subprocess.run(['gh','run','view','38122155900','--json','status,conclusion,headSha,attempt,jobs,url'],capture_output=True,text=True);assert q.returncode==0
j=json.loads(q.stdout);assert j['headSha']=='5773ac9d7bad13d41c2d00e456f8b633fa939579' and j['status']=='completed' and j['conclusion']=='success' and j['attempt']==2
(p/'ci-run.json').write_text(json.dumps(j,indent=2)+'\n');print('CI attempt2 PASS')
