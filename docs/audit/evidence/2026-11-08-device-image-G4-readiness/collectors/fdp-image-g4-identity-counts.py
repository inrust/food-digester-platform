import json,subprocess,os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
roles=['PlatformSuperAdmin','PlatformOperator','Auditor','CustomerAdmin','CustomerViewer']
def read(role):
 r=subprocess.run(['aws','cognito-idp','list-users-in-group','--user-pool-id','ap-southeast-1_hZMX8LpFo','--group-name',role,'--profile','esgiot-readonly','--region','ap-southeast-1','--query','length(Users[?Enabled == `true` && UserStatus == `CONFIRMED`])','--output','json','--cli-connect-timeout','10','--cli-read-timeout','20'],capture_output=True,text=True,env={**os.environ,'AWS_MAX_ATTEMPTS':'1'},timeout=45)
 return {'role':role,'confirmedEnabledCount':json.loads(r.stdout) if not r.returncode else None,'status':'OBSERVED' if not r.returncode else 'UNVERIFIED'}
with ThreadPoolExecutor(max_workers=4) as pool: rows=list(pool.map(read,roles))
d={'capturedAt':datetime.now(timezone.utc).isoformat(),'scope':'COGNITO_ROLE_COUNTS_ONLY_NO_IDENTITIES_OR_CREDENTIALS','roles':rows,'usableRunIdentitiesProven':False}
Path('/private/tmp/fdp-image-g4-identity-counts.json').write_text(json.dumps(d,indent=2)+'\n'); print(json.dumps(d))
