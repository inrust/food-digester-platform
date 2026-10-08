"""Four independent bounded read collectors; preserve failures before exact-ID recovery."""
import subprocess,json,shutil,concurrent.futures
from pathlib import Path
p=Path(__file__).parent
jobs=[('baseline-patch',[]),('baseline-audit',['--audit-get']),('sampling-patch',['--cold-sampling']),('sampling-audit',['--cold-sampling','--audit-get'])]
def call(name,args):
 (p/(name+'.command.json')).write_text(json.dumps(args,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:
  code=subprocess.run(args,stdout=o,stderr=e).returncode
 (p/(name+'.exit')).write_text(str(code)+'\n');print(name,code,flush=True)
 return code
def collect(job):
 name,flags=job
 return name,flags,call(name,['python3','scripts/collect-qa09-contract-correlation.py',str(p/'sample.json'),str(p/(name+'.json'))]+flags)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
 results=list(ex.map(collect,jobs))
for name,flags,code in results:
 out=p/(name+'.json')
 if out.exists() and json.loads(out.read_text())['gate']!='PASS':
  old=p/(name+'-first-partial.json');shutil.copyfile(out,old)
  code=call(name+'-exact-recovery',['python3',str(p/'collect-exact-invocation.py'),str(p/'sample.json'),str(out),str(old)]+flags)
 assert out.exists() and json.loads(out.read_text())['gate']=='PASS',name
