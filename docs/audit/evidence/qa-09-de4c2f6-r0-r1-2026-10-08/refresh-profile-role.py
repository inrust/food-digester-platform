"""Renew only the existing profile-matched standard CLI cache, never audit credentials."""
import json,subprocess,os,datetime,configparser
from pathlib import Path
root=Path(__file__).parent;profile='esgiot-infra'
c=configparser.ConfigParser();c.read(Path.home()/'.aws/config');assert c['profile '+profile]['sso_account_id']=='065986019555' and c['profile '+profile]['sso_role_name']=='FDP-InfraSetup'
def run(args):
 q=subprocess.run(args,capture_output=True,text=True,timeout=60);assert q.returncode==0,'PROFILE_REFRESH_COMMAND_FAILED';return json.loads(q.stdout)
old=run(['aws','configure','export-credentials','--profile',profile,'--format','process'])
files=[]
for p in (Path.home()/'.aws/cli/cache').glob('*.json'):
 try:
  j=json.loads(p.read_text())
  if j.get('ProviderType')=='sso' and j.get('Credentials',{}).get('AccessKeyId')==old['AccessKeyId']:files.append((p,j))
 except (ValueError,KeyError):pass
assert len(files)==1,'EXACT_PROFILE_CACHE_REQUIRED';p,j=files[0]
code="import {fromSSO} from '@aws-sdk/credential-provider-sso'; try {const c=await fromSSO({profile:'esgiot-infra',ignoreCache:true})();console.log(JSON.stringify({AccessKeyId:c.accessKeyId,SecretAccessKey:c.secretAccessKey,SessionToken:c.sessionToken,Expiration:c.expiration.toISOString(),AccountId:c.accountId}));} catch {process.exit(1)}"
fresh=run(['node','--input-type=module','-e',code]);assert fresh.get('AccountId') in [None,'065986019555']
expiry=datetime.datetime.fromisoformat(fresh['Expiration'].replace('Z','+00:00'));assert expiry>datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=90),'FRESH_CLEANUP_MARGIN_REQUIRED'
assert set(fresh)>=set(['AccessKeyId','SecretAccessKey','SessionToken','Expiration'])
fresh['AccountId']='065986019555';j['Credentials']=fresh
# Standard credential cache only; no copy or credential backup in workspace/evidence.
fd=os.open(p,os.O_WRONLY|os.O_TRUNC);os.fchmod(fd,0o600)
with os.fdopen(fd,'w') as f:json.dump(j,f)
identity=run(['aws','sts','get-caller-identity','--profile',profile]);assert identity['Account']=='065986019555' and 'AWSReservedSSO_FDP-InfraSetup_' in identity['Arn']
observed=run(['aws','configure','export-credentials','--profile',profile,'--format','process']);assert observed['AccessKeyId']==fresh['AccessKeyId']
out={'gate':'PASS','scope':'SAME_EXISTING_SSO_PROFILE_TEMPORARY_ROLE_SESSION_RENEWAL_ONLY','profile':profile,'accountId':identity['Account'],'previousExpiration':old['Expiration'],'freshExpiration':observed['Expiration'],'normalAuthCacheUpdated':True,'credentialsPersistedToEvidence':False,'iamKmsResourceChanges':0,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
assert not (root/'preflight/profile-role-refresh.json').exists();(root/'preflight/profile-role-refresh.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
