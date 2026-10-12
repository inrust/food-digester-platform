"""Read-only entry metadata. No credentials are persisted and no cloud write is made."""
from pathlib import Path
import configparser, datetime, hashlib, json, subprocess, shutil
root=Path(__file__).resolve().parent
sha='beaccece84ec865020aefc537af296228ec8b933'
def command(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=45)
 if p.returncode: raise RuntimeError('READ_ONLY_ENTRY_COMMAND_FAILED:'+args[0]+':'+args[1])
 return json.loads(p.stdout)
def aws(args,profile='esgiot-infra'):
 return command(['aws',*args,'--profile',profile,'--region','ap-southeast-1','--output','json','--no-cli-pager'])
r={'scope':'READ_ONLY_ENTRY_AND_PRIOR_VERIFIED_BYTE_BINDING','gate':'BLOCKED','cloudWrites':0,'sourceCommit':sha}
for name,run in [('ci',38243498847),('deploy',38243498850)]:
 r[name]=command(['gh','run','view',str(run),'--json','status,conclusion,headSha,url'])
 if r[name]['status']!='completed' or r[name]['conclusion']!='success' or r[name]['headSha']!=sha:
  (root/'preflight.json').write_text(json.dumps(r,indent=2)+'\n');raise RuntimeError('EXACT_COMMIT_PUBLISHED_SUCCESS_REQUIRED')
now=datetime.datetime.now(datetime.timezone.utc)
c=configparser.ConfigParser();c.read(Path.home()/'.aws/config');session=c['profile esgiot-infra']['sso_session'];sec=c['sso-session '+session]
valid=[]
for p in (Path.home()/'.aws/sso/cache').glob('*.json'):
 try:
  x=json.loads(p.read_bytes())
  if x.get('startUrl')==sec['sso_start_url'] and x.get('region')==sec['sso_region'] and 'accessToken'in x:
   valid.append(datetime.datetime.fromisoformat(x['expiresAt'].replace('Z','+00:00')))
 except (ValueError,KeyError):pass
r['loginExpiresAt']=max(valid).isoformat()
role=command(['aws','configure','export-credentials','--profile','esgiot-infra','--format','process'])
r['infraRoleExpiresAt']=role['Expiration'];del role
assert max(valid)>now+datetime.timedelta(minutes=10),'LOGIN_ENTRY_MARGIN_REQUIRED'
assert datetime.datetime.fromisoformat(r['infraRoleExpiresAt'].replace('Z','+00:00'))>now+datetime.timedelta(minutes=75),'CLEANUP_ENTRY_MARGIN_REQUIRED'
identity=aws(['sts','get-caller-identity']);assert identity['Account']=='065986019555' and ':assumed-role/AWSReservedSSO_FDP-InfraSetup_'in identity['Arn'];r['accountId']=identity['Account']
priorRoot=root.parent/'qa-09-ad213fa-r0-r1-2026-10-12'
manifest=json.loads((priorRoot/'manifest.json').read_bytes());prior=priorRoot/'restore/application-version.json'
digest=hashlib.sha256(prior.read_bytes()).hexdigest();assert digest==manifest['files']['restore/application-version.json']
r['priorVerifiedBytes']={'path':str(prior),'sha256':digest,'reuseRule':'Fresh codeSha256 AND immutable asset bucket/key AND artifact digest must still match'}
if not (root/'application-version.json').exists():shutil.copyfile(prior,root/'application-version.json')
r['checkedAt']=now.isoformat();r['gate']='PASS';(root/'preflight.json').write_text(json.dumps(r,indent=2)+'\n');print('PASS read-only entry; no fixtures created')
