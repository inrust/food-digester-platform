"""Serial bounded normal/exact reads; one explicit recovery and independent budget proof."""
import subprocess,json,shutil,hashlib
from pathlib import Path
p=Path(__file__).parent
jobs=[('baseline-patch',[]),('baseline-audit',['--audit-get']),('sampling-patch',['--cold-sampling']),('sampling-audit',['--cold-sampling','--audit-get'])]
def call(name,args):
 assert not (p/(name+'.exit')).exists(),'NO_COLLECTION_STEP_OVERWRITE'
 (p/(name+'.command.json')).write_text(json.dumps(args,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:code=subprocess.run(args,stdout=o,stderr=e).returncode
 (p/(name+'.exit')).write_text(str(code)+'\n');print(name,code,flush=True);return code
def collect(job):
 name,flags=job
 if p.name=='r1' and name.endswith('-patch'):flags=flags+['--observer-cost','--owned-boundaries']
 first=p/(name+'-original.json');out=p/(name+'.json');assert not first.exists() and not out.exists()
 code=call(name+'-original',['python3','scripts/collect-qa09-contract-correlation.py',str(p/'sample.json'),str(first)]+flags)
 assert code==0 and first.exists(),'ORIGINAL_READ_REQUIRED'
 firstBytes=first.read_bytes();firstHash=hashlib.sha256(firstBytes).hexdigest();prior=[]
 if json.loads(firstBytes)['gate']=='PASS':shutil.copyfile(first,out)
 else:
  code=call(name+'-exact',['python3','scripts/collect-qa09-contract-correlation.py',str(p/'sample.json'),str(out),'--exact-from',str(first),'--exact-sha256',firstHash]+flags)
  prior=[str(first)]
 assert first.read_bytes()==firstBytes,'ORIGINAL_RECEIPT_DRIFT'
 assert code==0 and out.exists(),'CORRELATION_OUTPUT_REQUIRED'
 assert call(name+'-budget',['node','scripts/check-qa09-log-read-budget.mjs',str(p/'sample.json'),str(out)]+prior)==0,name
 assert json.loads(out.read_text())['gate']=='PASS',name
 return name
print([collect(job) for job in jobs])
