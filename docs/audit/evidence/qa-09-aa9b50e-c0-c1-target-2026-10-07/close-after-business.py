"""Wait for the exact unit process to finish; never replay business probes."""
import time,json,sys,subprocess,os
from pathlib import Path
root=Path(__file__).parent;mode=sys.argv[1];assert mode in ['c0','c1'];p=root/mode
start=time.monotonic()
while not (p/'pipeline.exit').exists():
 assert time.monotonic()-start<3600,'BOUNDED_BUSINESS_WAIT_TIMEOUT'
 time.sleep(10)
assert (p/'pipeline.exit').read_text().strip()=='0','BUSINESS_PROCESS_FAILED'
assert (p/'business.exit').read_text().strip()=='0'
args=['python3',str(root/'finish-unit.py'),mode]
(p/'closure-pipeline.command.json').write_text(json.dumps(args,indent=2)+'\n')
with (p/'closure-pipeline.stdout.log').open('w') as out,(p/'closure-pipeline.stderr.log').open('w') as err:code=subprocess.run(args,stdout=out,stderr=err).returncode
(p/'closure-pipeline.exit').write_text(str(code)+'\n');sys.exit(code)
