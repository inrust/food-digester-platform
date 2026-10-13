"""Read standard SSO/profile expiry only; never persist credential values."""
import configparser, datetime, json, pathlib, subprocess, sys
root=pathlib.Path(__file__).parent;out=root/sys.argv[1];assert not out.exists()
now=datetime.datetime.now(datetime.timezone.utc);home=pathlib.Path.home()
c=configparser.ConfigParser();c.read(home/'.aws/config');p=c['profile esgiot-infra']
assert p['sso_account_id']=='065986019555' and p['sso_role_name']=='FDP-InfraSetup'
s=c['sso-session '+p['sso_session']];expires=[]
for path in (home/'.aws/sso/cache').glob('*.json'):
 try:
  v=json.loads(path.read_text())
  if v.get('startUrl')==s['sso_start_url'] and v.get('region')==s['sso_region'] and v.get('accessToken'):
   expires.append(datetime.datetime.fromisoformat(v['expiresAt'].replace('Z','+00:00')))
 except (ValueError,KeyError,OSError):pass
assert expires
q=subprocess.run(['aws','configure','export-credentials','--profile','esgiot-infra','--format','process'],capture_output=True,text=True,timeout=60)
assert q.returncode==0,'PROFILE_READ_FAILED'
role=datetime.datetime.fromisoformat(json.loads(q.stdout)['Expiration'].replace('Z','+00:00'));login=max(expires)
a=(login-now).total_seconds()/60;b=(role-now).total_seconds()/60
result={'checkedAt':now.isoformat(),'loginExpiresAt':login.isoformat(),'roleExpiresAt':role.isoformat(),'loginRemainingMinutes':a,'roleRemainingMinutes':b,'credentialsSaved':False,'gate':'PASS' if a>=10 and b>=75 else 'BLOCKED'}
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));assert result['gate']=='PASS'
