"""Read only recent shared-project builds and retain exact prepared-source matches."""
import base64,concurrent.futures,datetime,hashlib,json,os,subprocess
from pathlib import Path
root=Path(__file__).parent;out=root/'restore/owned-build-terminal-bounded.json';assert not out.exists()
prepared={}
for p in root.rglob('*.preparation.json'):
 v=json.loads(p.read_text());spec=v.get('project',{}).get('source',{}).get('buildspec')
 if spec:
  env={x['name']:x['value'] for x in v['project']['environment']['environmentVariables']}
  prepared[(hashlib.sha256(spec.encode()).hexdigest(),env['QA09_FIXTURE_HASH'],hashlib.sha256(base64.b64decode(env['QA09_FIXTURE_PLAN_B64'],validate=True)).hexdigest())]={'plan':v['plan'],'action':v['plan']['action'],'prefix':v['plan']['prefix']}
def aws(args):
 q=subprocess.run(['aws',*args,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager','--cli-connect-timeout','5','--cli-read-timeout','10'],capture_output=True,text=True,timeout=40,env={**os.environ,'AWS_MAX_ATTEMPTS':'1'})
 assert q.returncode==0,'READ_ONLY_BUILD_INVENTORY_FAILED';return json.loads(q.stdout)
ids=aws(['codebuild','list-builds-for-project','--project-name','fdp-test-qa09-ten-device-fixtures','--sort-order','DESCENDING','--max-items','50'])['ids']
chunks=[ids[i:i+5] for i in range(0,len(ids),5)]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
 results=list(ex.map(lambda chunk:aws(['codebuild','batch-get-builds','--ids',*chunk,'--query','builds[].{id:id,buildStatus:buildStatus,startTime:startTime,serviceRole:serviceRole,source:source,environment:{environmentVariables:environment.environmentVariables}}']),chunks))
items=[v for batch in results for v in batch];own=[]
assert len(ids)<50 or min(datetime.datetime.fromisoformat(v['startTime']) for v in items)<datetime.datetime.fromisoformat('2026-10-10T00:21:00+00:00'),'RECENT_BUILD_WINDOW_NOT_FULLY_COVERED'
for v in items:
 h=hashlib.sha256(v['source']['buildspec'].encode()).hexdigest()
 env={x['name']:x['value'] for x in v['environment']['environmentVariables']}
 planBytes=base64.b64decode(env.get('QA09_FIXTURE_PLAN_B64',''),validate=True)
 key=(h,env.get('QA09_FIXTURE_HASH'),hashlib.sha256(planBytes).hexdigest())
 if key in prepared:
  plan=json.loads(base64.b64decode(env['QA09_FIXTURE_PLAN_B64'],validate=True));assert plan==prepared[key]['plan']
  assert v['serviceRole']=='arn:aws:iam::065986019555:role/fdp-test-migration-runner-role'
  own.append({'buildId':v['id'],'status':v['buildStatus'],'preparedBuildspecSha256':h,'fixtureSourceHash':key[1],'planHash':key[2],'action':prepared[key]['action'],'prefix':prepared[key]['prefix']})
known=set()
for p in root.rglob('*.json'):
 try:
  v=json.loads(p.read_text());bid=v.get('build',{}).get('id') if isinstance(v,dict) else None
  if bid and bid.startswith('fdp-test-qa09-ten-device-fixtures:'):known.add(bid)
 except (ValueError,AttributeError):pass
assert known.issubset({v['buildId'] for v in own}),'KNOWN_BUILD_MISSING_FROM_MATCHED_WINDOW'
assert own and all(v['status'] in ['SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT'] for v in own),'OWN_BUILD_NOT_TERMINAL'
v={'gate':'PASS','scope':'EXACT_PREPARED_SOURCE_AND_PLAN_MATCHES_ONLY_IN_LATEST_FIFTY_SHARED_PROJECT_BUILDS','sourceCommit':'b5522378aebca9340a0767b53ed3bab846ffc080','ownBuilds':own,'scanLimit':50,'batchSize':5,'maxReadConcurrency':4,'knownBuildCount':len(known),'fullOriginalRunWindowCovered':True,'allMatchingOwnBuildsTerminal':True,'originalUnknownStartResolved':False,'originalUnknownStartScope':'KNOWN_OR_EXACT_PLAN_MATCHED_BUILDS_ONLY_NO_PROOF_OF_UNKNOWN_START_NONEXECUTION','writes':0,'otherBuildDetailsPersisted':False,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fullQa09Accepted':False}
out.write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({'gate':'PASS','ownBuildCount':len(own),'writes':0}))
