"""Wait for profile-bound SSO renewal; persist expiration metadata, never credentials."""
import configparser,pathlib,json,datetime,time,subprocess,sys
root=pathlib.Path(__file__).parent;p=root/sys.argv[1];c=configparser.ConfigParser();c.read(pathlib.Path.home()/'.aws/config');session=c['profile esgiot-infra']['sso_session'];sec=c['sso-session '+session];started=time.monotonic()
while True:
 now=datetime.datetime.now(datetime.timezone.utc);valid=[]
 for path in (pathlib.Path.home()/'.aws/sso/cache').glob('*.json'):
  try:
   j=json.loads(path.read_text())
   if j.get('startUrl')==sec['sso_start_url'] and j.get('region')==sec['sso_region'] and 'accessToken' in j:
    expiry=datetime.datetime.fromisoformat(j['expiresAt'].replace('Z','+00:00'))
    if expiry>now+datetime.timedelta(minutes=10):valid.append(expiry)
  except (ValueError,KeyError):pass
 if valid:
  r=subprocess.run(['aws','sts','get-caller-identity','--profile','esgiot-infra'],capture_output=True,text=True,timeout=60);assert r.returncode==0;r=json.loads(r.stdout);assert r['Account']=='065986019555'
  e=subprocess.run(['aws','configure','export-credentials','--profile','esgiot-infra','--format','process'],capture_output=True,text=True,timeout=60);assert e.returncode==0;expiration=json.loads(e.stdout)['Expiration']
  roleExpiry=datetime.datetime.fromisoformat(expiration.replace('Z','+00:00'))
  if roleExpiry<=now+datetime.timedelta(minutes=75):
   assert time.monotonic()-started<600,'ROLE_CLEANUP_MARGIN_REQUIRED'
   time.sleep(10);continue
  (p/'renewable-session-gate.json').write_text(json.dumps({'gate':'PASS','scope':'PROFILE_BOUND_RENEWABLE_LOGIN_AND_TEST_ACCOUNT_ONLY','checkedAt':now.isoformat(),'session':session,'loginExpiresAt':max(valid).isoformat(),'infraRoleExpiresAt':expiration,'accountId':r['Account'],'minimumLoginRemainingMinutes':10,'minimumInfraRoleRemainingMinutes':75,'scopeLimit':'Entry cleanup margin only, not proof of continuous future renewal','credentialsPersisted':False},indent=2)+'\n');print('renewable session PASS',flush=True);break
 assert time.monotonic()-started<600,'RENEWABLE_SSO_REQUIRED_BEFORE_NEW_FIXTURES'
 time.sleep(10)
