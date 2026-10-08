"""Read existing exact invocations with corrected canonical boundary allowlist; no API probes."""
import subprocess,json,concurrent.futures
from pathlib import Path
root=Path(__file__).parent;p=root/'r0'
jobs=[('baseline-patch',[]),('baseline-audit',['--audit-get']),('sampling-patch',['--cold-sampling']),('sampling-audit',['--cold-sampling','--audit-get'])]
def collect(job):
 name,flags=job;out=p/(name+'-boundary-corrected.json');assert not out.exists(),'PRESERVE_RECOLLECTION';args=['python3',str(p/'collect-exact-with-call-returned.py'),str(p/'sample.json'),str(out),str(p/(name+'.json'))]+flags
 (p/(name+'-boundary-corrected.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'-boundary-corrected.stdout.log')).open('w') as o,(p/(name+'-boundary-corrected.stderr.log')).open('w') as e:q=subprocess.run(args,stdout=o,stderr=e)
 (p/(name+'-boundary-corrected.exit')).write_text(str(q.returncode)+'\n');assert q.returncode==0 and json.loads(out.read_text())['gate']=='PASS';return name
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
 for name in ex.map(collect,jobs):print(name,'PASS',flush=True)
