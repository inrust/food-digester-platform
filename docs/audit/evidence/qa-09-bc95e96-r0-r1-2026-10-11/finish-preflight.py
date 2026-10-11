"""After exact CI success, fresh artifact reads and one new capacity-only Plan, never replay unknown starts."""
import os,json,hashlib,subprocess
from pathlib import Path
root=Path(__file__).parent;p=root/'preflight';sha='bc95e9671a0bfb69effa95ad7c315b375199f132';run='38106069512'
ci=json.loads((p/'ci-run.json').read_text());assert ci['conclusion']=='success' and ci['headSha']==sha and ci['attempt']==2
blocked=root/'default-off/application-version.json';prior=root/'default-off/application-version-ci-pending.json'
j=json.loads(blocked.read_text());assert j['gate']=='BLOCKED' and j['lambdaArtifacts']==[] and j['blockers']==['EXACT_COMMIT_CI_NOT_SUCCESSFUL'] and not prior.exists()
original=blocked.read_bytes();blocked.rename(prior)
(p/'default-19-recovery-origin.json').write_text(json.dumps({'scope':'READ_ONLY_AFTER_CI_GATE_CHANGED_NO_PRIOR_ZIP_DOWNLOAD_OR_BUSINESS_REPLAY','originalPath':str(prior),'originalSha256':hashlib.sha256(original).hexdigest(),'originalGate':'BLOCKED','ciAttempt':2,'readRetryCount':1},indent=2)+'\n')
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 assert not (p/(name+'.step.exit')).exists(),'NO_STEP_REPLAY'
 (p/(name+'.step.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.step.stdout.log')).open('w') as o,(p/(name+'.step.stderr.log')).open('w') as e:q=subprocess.run(args,env=env,stdout=o,stderr=e)
 (p/(name+'.step.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
call('ci-hosted-after-rerun',['python3',str(root/'collect-hosted-verify.py'),'preflight','38106069539'])
call('default-19-after-ci',['node','scripts/collect-qa09-application-version.mjs',str(blocked)])
call('default-config-after-ci',['node','scripts/qa09-account-read-config.mjs',str(root/'default-off/qa09-deployment-inputs.json'),str(blocked),str(root/'default-off/actual-config.json')])
call('capacity',['node',str(root/'capacity-readonly.mjs'),str(p/'capacity-before.json')])
call('capacity-gate',['python3',str(root/'capacity-gate.py'),str(p)])
call('prestart-entry',['node',str(root/'check-prestart-entry.mjs'),'preflight'])
call('renewable-session',['python3',str(root/'await-renewable-session.py'),'preflight'])
call('close-entry',['python3',str(root/'close-entry.py')])
