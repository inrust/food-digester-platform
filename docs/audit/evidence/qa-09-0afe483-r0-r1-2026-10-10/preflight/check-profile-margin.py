import json,subprocess,datetime,configparser
from pathlib import Path
root=Path(__file__).parent;now=datetime.datetime.now(datetime.timezone.utc);out={'checkedAt':now.isoformat(),'credentialsPersisted':False,'profiles':[]}
c=configparser.ConfigParser();c.read(Path.home()/'.aws/config');sec=c['sso-session '+c['profile esgiot-infra']['sso_session']];expiry=[]
for p in (Path.home()/'.aws/sso/cache').glob('*.json'):
 try:
  x=json.loads(p.read_text())
  if x.get('startUrl')==sec['sso_start_url'] and x.get('region')==sec['sso_region'] and 'accessToken' in x:expiry.append(x['expiresAt'])
 except (OSError,ValueError,KeyError):pass
out['loginExpiresAt']=max(expiry) if expiry else None
for profile in ['esgiot-readonly','esgiot-infra']:
 row={'profile':profile};out['profiles'].append(row)
 for op,args in [('identity',['sts','get-caller-identity']),('expiration',['configure','export-credentials','--format','process'])]:
  q=subprocess.run(['aws',*args,'--profile',profile,'--output','json','--no-cli-pager'],capture_output=True,text=True,timeout=60)
  if q.returncode:row['gate']='FAIL';row['failedOperation']=op;row['code']='SSO_SESSION_EXPIRED' if 'Token has expired' in q.stderr else 'CLI_READ_FAILED';break
  v=json.loads(q.stdout)
  if op=='identity':assert v['Account']=='065986019555';row['accountId']=v['Account'];row['arn']=v['Arn']
  else:row['roleExpiresAt']=v['Expiration'];row['gate']='PASS';row['cleanupMarginMinutes']=(datetime.datetime.fromisoformat(v['Expiration'].replace('Z','+00:00'))-now).total_seconds()/60
expiry=[]
for p in (Path.home()/'.aws/sso/cache').glob('*.json'):
 try:
  x=json.loads(p.read_text())
  if x.get('startUrl')==sec['sso_start_url'] and x.get('region')==sec['sso_region'] and 'accessToken' in x:expiry.append(x['expiresAt'])
 except (OSError,ValueError,KeyError):pass
out['loginExpiresAt']=max(expiry) if expiry else None
(root/'profile-margin.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
