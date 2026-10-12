"""Fresh read-only closure after R0 verification failed before AWS credentials/deployment."""
import subprocess,json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;p=root/'preflight';assert not (p/'predeployment-failure-closure.json').exists()
h=lambda b:hashlib.sha256(b).hexdigest()
run=json.loads((root/'r0/failed-run.stdout.log').read_text());assert run['conclusion']=='failure' and run['headSha']=='be97cb60d356c6b86eea85455e2087ff54d0bb5a'
job=run['jobs'][0];steps=job['steps']
assert next(s for s in steps if s['name']=='Run pnpm verify')['conclusion']=='failure'
for name in ['Run aws-actions/configure-aws-credentials@v6.3.0','Verify target account and exact commit','Run node scripts/esgiot-cdk.mjs deploy AppDependencies']:
 assert next(s for s in steps if s['name']==name)['conclusion']=='skipped'
assert not any((root/m/'sample.json').exists() for m in ['r0','r1'])
assert not (root/'r1/dispatch.exit').exists() and not (root/'restore/dispatch.exit').exists()
prior=json.loads((root/'default-off/actual-config.json').read_text());build=json.loads((p/'capacity-before.json').read_text())['build']['id']
query='{revisionId:RevisionId,codeSha256:CodeSha256,memory:MemorySize,state:State,update:LastUpdateStatus,envName:Environment.Variables.ENV_NAME,pool:Environment.Variables.FDP_DB_POOL_MAX,engineCpu:Environment.Variables.FDP_QA09_ENGINE_CPU_DIAGNOSIS,preconnect:Environment.Variables.FDP_QA09_AUTHENTICATED_PRECONNECT,accountReadCandidate:Environment.Variables.FDP_QA09_ACCOUNT_READ_CANDIDATE,contractLoadDetail:Environment.Variables.FDP_QA09_CONTRACT_LOAD_DETAIL,contractPublicBoundaries:Environment.Variables.FDP_QA09_CONTRACT_PUBLIC_BOUNDARIES,contractObserverCost:Environment.Variables.FDP_CONTRACT_OBSERVER_COST}'
rows={}
for name,args in [('failure-api-config',['lambda','get-function-configuration','--function-name','fdp-test-api','--query',query]),('failure-api-concurrency',['lambda','get-function-concurrency','--function-name','fdp-test-api']),('failure-own-build',['codebuild','batch-get-builds','--ids',build,'--query','{builds:builds[].{id:id,status:buildStatus,projectName:projectName},notFound:buildsNotFound}'])]:
 command=['aws',*args,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager']
 (p/(name+'.command.json')).write_text(json.dumps(command)+'\n');q=subprocess.run(command,capture_output=True,text=True,timeout=30)
 (p/(name+'.stderr.log')).write_text(q.stderr);(p/(name+'.exit')).write_text(str(q.returncode)+'\n');assert q.returncode==0
 (p/(name+'.json')).write_text(q.stdout);rows[name]=json.loads(q.stdout)
c=rows['failure-api-config'];assert c['revisionId']==prior['config']['revisionId'] and c['codeSha256']==prior['config']['codeSha256'] and c['state']=='Active' and c['update']=='Successful'
assert c['memory']==512 and c['pool']=='1' and c['engineCpu']=='true' and c['envName']=='test'
assert all(c[k]=='false' for k in ['preconnect','accountReadCandidate','contractLoadDetail','contractPublicBoundaries','contractObserverCost'])
assert rows['failure-api-concurrency']['ReservedConcurrentExecutions']==12
assert rows['failure-own-build']=={'builds':[{'id':build,'status':'SUCCEEDED','projectName':'fdp-test-qa09-ten-device-fixtures'}],'notFound':[]}
files=['r0/failed-run.stdout.log','r0/failed-job.stdout.log','r0/wait-success.pipeline.exit','default-off/application-version.json','default-off/actual-config.json','preflight/capacity-before.json','preflight/capacity-before.json.preparation.json','preflight/capacity-before.json.started.json',*[str((p/(n+'.json')).relative_to(root)) for n in rows]]
v={'gate':'PASS','scope':'R0_FAILED_VERIFY_BEFORE_AWS_DEPLOYMENT_NO_BUSINESS_FIXTURES_DEFAULT_OFF_UNCHANGED','sourceCommit':run['headSha'],'failedRunId':run['databaseId'],'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'r0StageGate':'FAIL','r1':'NOT_RUN','restore':'NOT_REQUIRED','businessFixtures':0,'newBusinessBuilds':0,'knownReadOnlyBuilds':1,'allKnownOwnBuildsTerminal':True,'apiRevisionUnchanged':True,'fiveCandidatesOff':True,'bindings':{n:h((root/n).read_bytes()) for n in files},'fullQa09Accepted':False,'p95Accepted':False}
(p/'predeployment-failure-closure.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps(v))
