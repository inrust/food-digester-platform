"""Read-only GitHub downloaded-artifact and exact cloud config provenance."""
import json,sys,subprocess,hashlib
from pathlib import Path
root=Path(__file__).parent
mode,run=sys.argv[1:]; assert mode in ['default-off','r0','r1','restore'] and run.isdigit()
p=root/mode
sha='0afe48384537c8c79ec6ce87276858120b9fd6ef'
def save(name,args):
 q=subprocess.run(args,capture_output=True,text=True,timeout=180)
 (p/(name+'.stderr.log')).write_text(q.stderr);(p/(name+'.exit')).write_text(str(q.returncode)+'\n');assert q.returncode==0,name
 (p/(name+'.json')).write_text(q.stdout);return json.loads(q.stdout)
r=save('deploy-run',['gh','run','view',run,'--json','headSha,status,conclusion,event,attempt,jobs,url'])
assert r['headSha']==sha and r['status']=='completed' and r['conclusion']=='success' and r['event']==('push' if mode=='default-off' else 'workflow_dispatch')
assert any(s['name']=='Run pnpm verify' and s['conclusion']=='success' for j in r['jobs'] for s in j['steps'])
name='qa09-deployment-inputs-'+run+'-'+str(r['attempt'])
if (p/'published-input/qa09-deployment-inputs.json').exists():
 assert (p/'artifact-download.exit').read_text().strip()=='0' and (p/'qa09-deployment-inputs.json').read_bytes()==(p/'published-input/qa09-deployment-inputs.json').read_bytes(),'PRIOR_SUCCESSFUL_SAME_ARTIFACT_BYTES_REQUIRED'
 (p/'artifact-reuse-binding.json').write_text(json.dumps({'gate':'PASS','runId':run,'runAttempt':str(r['attempt']),'artifactName':name,'sourceSha256':hashlib.sha256((p/'published-input/qa09-deployment-inputs.json').read_bytes()).hexdigest(),'scope':'EXISTING_SUCCESSFUL_SAME_RUN_ARTIFACT_BYTES_ONLY'},indent=2)+'\n')
else:
 q=subprocess.run(['gh','run','download',run,'--name',name,'--dir',str(p/'published-input')],capture_output=True,text=True,timeout=180)
 (p/'artifact-download.stderr.log').write_text(q.stderr);(p/'artifact-download.exit').write_text(str(q.returncode)+'\n');assert q.returncode==0
fresh=(p/'published-input/qa09-deployment-inputs.json').read_bytes()
if (p/'qa09-deployment-inputs.json').exists(): assert fresh==(p/'qa09-deployment-inputs.json').read_bytes(),'INPUT_ARTIFACT_BYTES_DRIFT'
(p/'qa09-deployment-inputs.json').write_bytes(fresh)
v=json.loads(fresh)
assert v['gate']=='PASS' and v['sourceCommit']==sha and v['runId']==run and v['event']==('push' if mode=='default-off' else 'workflow_dispatch') and v['runAttempt']==str(r['attempt']) and v['engineCpu'] is True and v['authenticatedPreconnect']==(mode in ['r0','r1']) and v['accountReadCandidate']==(mode=='r1') and v['rolloutPhase']=='immediate' and v['contractLoadDetail']==(mode in ['r0','r1'])
for key,path in [('workflowSha256','.github/workflows/deploy-test.yml'),('resolverSha256','scripts/record-qa09-deployment-inputs.mjs'),('rolloutResolverSha256','scripts/esgiot-cdk.mjs')]: assert hashlib.sha256(subprocess.check_output(['git','show',sha+':'+path])).hexdigest()==v[key]
aws=['--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager']
c=save('api-config',['aws','lambda','get-function-configuration','--function-name','fdp-test-api','--query','{revisionId:RevisionId,memory:MemorySize,state:State,update:LastUpdateStatus,envName:Environment.Variables.ENV_NAME,pool:Environment.Variables.FDP_DB_POOL_MAX,engineCpu:Environment.Variables.FDP_QA09_ENGINE_CPU_DIAGNOSIS,preconnect:Environment.Variables.FDP_QA09_AUTHENTICATED_PRECONNECT,accountReadCandidate:Environment.Variables.FDP_QA09_ACCOUNT_READ_CANDIDATE,contractLoadDetail:Environment.Variables.FDP_QA09_CONTRACT_LOAD_DETAIL,parallelSecrets:Environment.Variables.FDP_ADMIN_PARALLEL_SECRETS}']+aws)
n=save('api-concurrency',['aws','lambda','get-function-concurrency','--function-name','fdp-test-api']+aws)
assert c['envName']=='test' and c['pool']=='1' and c['memory']==512 and c['engineCpu']=='true' and c['preconnect']==str(mode in ['r0','r1']).lower() and c['accountReadCandidate']==str(mode=='r1').lower() and c['contractLoadDetail']==str(mode in ['r0','r1']).lower() and c['state']=='Active' and c['update']=='Successful' and n['ReservedConcurrentExecutions']==12
out={'gate':'PASS','sourceCommit':sha,'runId':run,'mode':mode,'scope':'ACTUAL_RUN_ARTIFACT_SOURCE_AND_CONFIG','budget':{'pool':1,'memoryMiB':512,'reserved':12,'dbConnectionBudget':63,'maxBudget':70},'bindings':{f:hashlib.sha256((p/f).read_bytes()).hexdigest() for f in ['deploy-run.json','qa09-deployment-inputs.json','api-config.json','api-concurrency.json']},'p95Accepted':False,'fullQa09Accepted':False}
(p/'deployment-input-binding.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'gate':'PASS','mode':mode,'runId':run}))
