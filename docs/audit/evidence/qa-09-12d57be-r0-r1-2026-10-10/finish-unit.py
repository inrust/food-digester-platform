"""Close one completed unit: independent empty audit and read-only exact correlations."""
import os,json,subprocess,sys
from pathlib import Path
root=Path(__file__).parent;mode=sys.argv[1];assert mode in ['r0','r1'];p=root/mode
provenance=json.loads((p/'deployment-input-binding.json').read_text());sha=provenance['sourceCommit'];run=provenance['runId']
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TIMEOUT_MS':'180000'}
child=json.loads((p/'sample.json').read_text());parent=json.loads((p/('sample.json.fixtures.effective.json' if (p/'sample.json.fixtures.effective.json').exists() else 'sample.json.fixtures.json')).read_text())
wrapper=json.loads((p/'sample.json.gate.json').read_text());assert wrapper['gate']=='PASS' and wrapper['parentCleanupObservation']['gate']=='PASS','ORIGINAL_PARENT_WRAPPER_REQUIRED'
assert child['gate']=='PASS' and not (p/'sample.json.fixtures.effective.json').exists(),'ORIGINAL_UNIT_ONLY'
assert child['cleanupComplete'] and all(c['result']=='PASS' for c in child['cleanup']) and all(c['result']=='PASS' for c in parent['cleanup']) and parent['gate']=='PASS','OWN_CLEANUP_REQUIRED'
def call(name,args):
 assert not (p/(name+'.closure.exit')).exists(),'NO_REPLAY_CLOSURE_STEP'
 (p/(name+'.closure.command.json')).write_text(json.dumps(args,indent=2)+'\n')
 with (p/(name+'.closure.stdout.log')).open('w') as out,(p/(name+'.closure.stderr.log')).open('w') as err:
  code=subprocess.run(args,stdout=out,stderr=err,env=env).returncode
 (p/(name+'.closure.exit')).write_text(str(code)+'\n');print(name,code,flush=True);assert code==0,name
call('audit-empty',['node',str(p/'audit-empty.mjs')])
call('negative-get',['node',str(p/'negative-get.mjs')])
call('collect-correlations',['python3',str(p/'collect-correlations.py')])
call('collect-initial',['python3',str(p/'collect-initial-phases.py')])
call('collect-negative',['python3',str(p/'collect-negative-phases.py')])
call('check-negative',['node',str(p/'check-negative.mjs')])
call('runtime-final',['node','scripts/collect-qa09-application-version.mjs',str(p/'runtime-final.json'),'--runtime-only'])
aws=['--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager']
for name,args in [('api-final-config',['lambda','get-function-configuration','--function-name','fdp-test-api','--query','{revisionId:RevisionId,memory:MemorySize,state:State,update:LastUpdateStatus,envName:Environment.Variables.ENV_NAME,pool:Environment.Variables.FDP_DB_POOL_MAX,engineCpu:Environment.Variables.FDP_QA09_ENGINE_CPU_DIAGNOSIS,preconnect:Environment.Variables.FDP_QA09_AUTHENTICATED_PRECONNECT,accountReadCandidate:Environment.Variables.FDP_QA09_ACCOUNT_READ_CANDIDATE,contractLoadDetail:Environment.Variables.FDP_QA09_CONTRACT_LOAD_DETAIL,contractPublicBoundaries:Environment.Variables.FDP_QA09_CONTRACT_PUBLIC_BOUNDARIES,parallelSecrets:Environment.Variables.FDP_ADMIN_PARALLEL_SECRETS}']),('api-final-concurrency',['lambda','get-function-concurrency','--function-name','fdp-test-api'])]:
 q=subprocess.run(['aws']+args+aws,capture_output=True,text=True,timeout=180)
 (p/(name+'.stderr.log')).write_text(q.stderr);(p/(name+'.exit')).write_text(str(q.returncode)+'\n');assert q.returncode==0;(p/(name+'.json')).write_text(q.stdout)
call('connection-budget',['python3',str(root/'collect-connection-budget.py'),str(p)])
call('check-unit',['python3',str(p/'check-unit.py')])
call('initial-topology',['node',str(root/'check-initial-topology.mjs'),mode])
call('prestart-entry',['node',str(root/'check-prestart-entry.mjs'),mode])
call('complete-unit',['python3',str(root/'complete-unit.py'),mode])
