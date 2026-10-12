"""Local repair matrix, ownership, source and hygiene checks; no target or network calls."""
from pathlib import Path
import ast,json,hashlib,re,base64,gzip,subprocess
p=Path(__file__).resolve().parent;repo=p.parents[3];h=lambda b:hashlib.sha256(b).hexdigest()
for name in ['proof','real-prisma','lint','format','scripts-loopback-authorized','lint-repository','format-repository']:assert (p/(name+'.exit')).read_text().strip()=='0',name
assert 'tests 35' in (p/'proof.stdout.log').read_text() and 'Tests  17 passed' in (p/'real-prisma.stdout.log').read_text()
assert 'tests 1270' in (p/'scripts-loopback-authorized.stdout.log').read_text()
assert (p/'scripts.exit').read_text().strip()=='1' and 'listen EPERM' in (p/'scripts.stdout.log').read_text()
m=json.loads((p/'fresh-process-matrix/matrix.json').read_text());assert m['gate']=='PASS' and len(m['rows'])==m['budget']['childProcesses']==17
counts={}
for row in m['rows']:
 b=(p/'fresh-process-matrix'/row['receipt']).read_bytes();assert h(b)==row['sha256'];v=json.loads(b)
 for k in ['begin','commit','rollback','checkout','release','dispose','networkAttempts']:counts[k]=counts.get(k,0)+v['counts'][k]
assert counts=={'begin':39,'commit':33,'rollback':6,'checkout':56,'release':56,'dispose':17,'networkAttempts':0}
for row in m['inputs']:assert h((repo/row['path']).read_bytes())==row['sha256']
patterns=[rb'(?:AKIA|ASIA)[A-Z0-9]{16}',rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}',rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----']
for f in p.rglob('*'):
 if f.is_file():assert not any(re.search(x,f.read_bytes()) for x in patterns),str(f)
subprocess.run(['git','diff','--check'],check=True)
v={'gate':'LOCAL_PUBLIC_WINDOW_PARENT_PASS','scope':'OFFLINE_PROOF_AND_REAL_PRISMA_CONTROLLED_PG_ONLY','proofTests':35,'realPrismaCases':17,'freshProcesses':17,'scriptTests':1270,'ownership':counts,'targetPhaseGateChanged':False,'roundingBoundMs':5,'fullQa09Accepted':False,'p95Accepted':False,'sourceBindings':{n:h((repo/n).read_bytes()) for n in ['scripts/qa09-contract-windows-proof.mjs','scripts/qa09-contract-windows-proof.test.mjs','scripts/run-qa09-contract-windows-offline.mjs','packages/database/test/contract-windows-offline.test.ts']}}
(p/'summary.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps(v))
