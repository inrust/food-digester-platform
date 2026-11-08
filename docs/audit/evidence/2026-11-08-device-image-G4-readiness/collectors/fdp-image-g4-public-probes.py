import json,urllib.request,urllib.error,hashlib
from datetime import datetime,timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
admin='https://api.bio-nexa.com'
device='00000000-0000-4000-8000-000000000000'; viewer='00000000-0000-4000-8000-000000000001'
paths=[('/api/v1/admin/devices/'+device+'/live-image/viewers/'+viewer,'PUT'),('/api/v1/admin/devices/'+device+'/live-image/viewers/'+viewer,'DELETE'),('/api/v1/admin/devices/'+device+'/live-image/latest','GET')]
tasks=[(path,'OPTIONS',origin,method) for path,method in paths for origin in ['https://admin.bio-nexa.com','https://rejected.example.invalid']]
tasks.append((paths[-1][0],'GET',None,None))
def read(task):
 path,method,origin,requested=task
 headers={}
 if origin: headers.update({'Origin':origin,'Access-Control-Request-Method':requested,'Access-Control-Request-Headers':'authorization,content-type,x-request-id'})
 request=urllib.request.Request(admin+path,method=method,headers=headers)
 row={'method':method,'pathTemplate':path.replace(device,'{deviceId}').replace(viewer,'{viewerId}'),'origin':origin,'requestedMethod':requested,'capturedAt':datetime.now(timezone.utc).isoformat()}
 try:
  try: response=urllib.request.urlopen(request,timeout=20)
  except urllib.error.HTTPError as e: response=e
  body=response.read(262145); assert len(body)<=262144
  allowed=['Access-Control-Allow-Origin','Access-Control-Allow-Methods','Access-Control-Allow-Headers','Access-Control-Expose-Headers','Cache-Control','ETag','X-Request-Id','Vary']
  row.update(status=response.code,bytes=len(body),bodySha256=hashlib.sha256(body).hexdigest(),headers={k:response.headers[k] for k in allowed if response.headers.get(k)})
 except Exception as e: row.update(error=type(e).__name__)
 return row
with ThreadPoolExecutor(max_workers=4) as pool: observations=list(pool.map(read,tasks))
receipt={'mode':'TARGET_CLOUD','syntheticResponsesAllowed':False,'sourceCommit':'69c76e1dd508bf6e03dd21992194a8280109cd0a','accountId':'065986019555','region':'ap-southeast-1','stackName':'fdp-test-app','scope':'UNAUTHENTICATED_PUBLIC_PREFLIGHT_ONLY','businessCasesPromoted':False,'observations':observations}
Path('/private/tmp/fdp-image-g4-public-probes.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(observations),flush=True)
