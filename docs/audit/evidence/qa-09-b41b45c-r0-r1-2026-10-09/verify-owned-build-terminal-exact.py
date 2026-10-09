"""Read only recent shared-project builds and retain exact prepared-source matches."""
import base64,datetime,hashlib,json,subprocess
from pathlib import Path
root=Path(__file__).parent;out=root/'restore/owned-build-terminal-exact.json';assert not out.exists()
prepared={}
for p in root.rglob('*.preparation.json'):
 v=json.loads(p.read_text());spec=v.get('project',{}).get('source',{}).get('buildspec')
 if spec:
  env={x['name']:x['value'] for x in v['project']['environment']['environmentVariables']}
  prepared[(hashlib.sha256(spec.encode()).hexdigest(),env['QA09_FIXTURE_HASH'])]={'plan':v['plan'],'action':v['plan']['action'],'prefix':v['plan']['prefix']}
def aws(args):
 q=subprocess.run(['aws',*args,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager'],capture_output=True,text=True,timeout=90)
 assert q.returncode==0,'READ_ONLY_BUILD_INVENTORY_FAILED';return json.loads(q.stdout)
ids=aws(['codebuild','list-builds-for-project','--project-name','fdp-test-qa09-ten-device-fixtures','--sort-order','DESCENDING','--max-items','50'])['ids']
items=aws(['codebuild','batch-get-builds','--ids',*ids])['builds'];own=[]
assert len(ids)<50 or min(datetime.datetime.fromisoformat(v['startTime']) for v in items)<datetime.datetime.fromisoformat('2026-10-08T23:20:00+00:00'),'RECENT_BUILD_WINDOW_NOT_FULLY_COVERED'
for v in items:
 h=hashlib.sha256(v['source']['buildspec'].encode()).hexdigest()
 env={x['name']:x['value'] for x in v['environment']['environmentVariables']}
 key=(h,env.get('QA09_FIXTURE_HASH'))
 if key in prepared:
  plan=json.loads(base64.b64decode(env['QA09_FIXTURE_PLAN_B64'],validate=True));assert plan==prepared[key]['plan']
  assert v['serviceRole']=='arn:aws:iam::065986019555:role/fdp-test-migration-runner-role'
  own.append({'buildId':v['id'],'status':v['buildStatus'],'preparedBuildspecSha256':h,'planHash':key[1],'action':prepared[key]['action'],'prefix':prepared[key]['prefix']})
known=set()
for p in root.rglob('*.json'):
 try:
  v=json.loads(p.read_text());bid=v.get('build',{}).get('id') if isinstance(v,dict) else None
  if bid and bid.startswith('fdp-test-qa09-ten-device-fixtures:'):known.add(bid)
 except (ValueError,AttributeError):pass
assert known.issubset({v['buildId'] for v in own}),'KNOWN_BUILD_MISSING_FROM_MATCHED_WINDOW'
assert own and all(v['status'] in ['SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT'] for v in own),'OWN_BUILD_NOT_TERMINAL'
v={'gate':'PASS','scope':'EXACT_PREPARED_SOURCE_AND_PLAN_MATCHES_ONLY_IN_LATEST_FIFTY_SHARED_PROJECT_BUILDS','sourceCommit':'b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e','ownBuilds':own,'scanLimit':50,'knownBuildCount':len(known),'fullOriginalRunWindowCovered':True,'allMatchingOwnBuildsTerminal':True,'writes':0,'otherBuildDetailsPersisted':False,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fullQa09Accepted':False}
out.write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({'gate':'PASS','ownBuildCount':len(own),'writes':0}))
