"""Bounded read collection using the single repository whitelist; no business calls or overwrite."""
import subprocess,json,shutil,concurrent.futures
from pathlib import Path
p=Path(__file__).parent
jobs=[('baseline-patch',[]),('baseline-audit',['--audit-get']),('sampling-patch',['--cold-sampling']),('sampling-audit',['--cold-sampling','--audit-get'])]
def call(name,args):
 assert not (p/(name+'.exit')).exists(),'NO_COLLECTION_STEP_OVERWRITE'
 (p/(name+'.command.json')).write_text(json.dumps(args,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:code=subprocess.run(args,stdout=o,stderr=e).returncode
 (p/(name+'.exit')).write_text(str(code)+'\n');print(name,code,flush=True);return code
def collect(job):
 name,flags=job;first=p/(name+'-original.json');out=p/(name+'.json');assert not first.exists() and not out.exists()
 code=call(name+'-original',['python3','scripts/collect-qa09-contract-correlation.py',str(p/'sample.json'),str(first)]+flags)
 assert code==0 and first.exists(),'ORIGINAL_READ_REQUIRED'
 if json.loads(first.read_text())['gate']=='PASS':shutil.copyfile(first,out)
 else:
  code=call(name+'-exact',['python3','scripts/collect-qa09-contract-correlation.py',str(p/'sample.json'),str(out),'--exact-from',str(first)]+flags)
 assert code==0 and out.exists() and json.loads(out.read_text())['gate']=='PASS',name
 return name
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:print(list(ex.map(collect,jobs)))
