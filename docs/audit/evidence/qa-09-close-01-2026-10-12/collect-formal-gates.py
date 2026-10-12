"""Existing local evidence validators; missing formal receipts are not new cloud failures."""
from pathlib import Path
import subprocess, json, hashlib, concurrent.futures
root=Path(__file__).resolve().parent
commands=[
 ('check:aws-iot-evidence','scripts/check-aws-iot-data-path-evidence.mjs'),
 ('check:aws-data-processing-evidence','scripts/check-aws-data-processing-evidence.mjs'),
 ('check:aws-admin-evidence','scripts/check-aws-admin-cus-dev-evidence.mjs'),
 ('check:aws-admin-business-evidence','scripts/check-aws-admin-business-evidence.mjs'),
 ('check:aws-med-rbac-aud-dash-set-evidence','scripts/check-aws-med-rbac-aud-dash-set-evidence.mjs'),
 ('check:admin-web-target-evidence','scripts/check-admin-web-target-evidence.mjs'),
 ('check:admin-web-fe11-15-target-evidence','scripts/check-admin-web-fe11-15-target-evidence.mjs'),
 ('check:admin-web-fe16-19-target-evidence','scripts/check-admin-web-fe16-19-target-evidence.mjs'),
]
def collect(entry):
 name,path=entry
 r=subprocess.run(['node',path],capture_output=True,text=True,timeout=30)
 (root/(name.replace(':','-')+'.stdout.log')).write_text(r.stdout)
 (root/(name.replace(':','-')+'.stderr.log')).write_text(r.stderr)
 return {'command':'pnpm '+name,'equivalentInvoked':['node',path],'exitCode':r.returncode,
  'validatorSha256':hashlib.sha256(Path(path).read_bytes()).hexdigest(),
  'stdout':r.stdout[:1800],'stderr':r.stderr[:1800],
  'gate':'PASS_EXISTING_VALIDATOR' if r.returncode==0 else 'FORMAL_GATE_NOT_SATISFIED',
  'cloudRequests':0}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: rows=list(pool.map(collect,commands))
(root/'formal-gates.json').write_text(json.dumps({'scope':'READ_ONLY_LOCAL_FORMAL_RECEIPT_INVENTORY','results':rows,'fullQa09Accepted':False},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'validators':len(rows),'passed':sum(r['exitCode']==0 for r in rows),'cloudRequests':0}))
