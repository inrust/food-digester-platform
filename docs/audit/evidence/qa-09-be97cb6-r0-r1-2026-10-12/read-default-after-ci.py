"""Fresh read after CI prerequisite closure, never replace original BLOCKED receipt."""
import os,subprocess,json,hashlib,datetime
from pathlib import Path
root=Path(__file__).resolve().parent;p=root/'preflight';d=root/'default-off'
sha='be97cb60d356c6b86eea85455e2087ff54d0bb5a';run='38198491221'
ci=json.loads((p/'ci-run.json').read_text());assert ci['headSha']==sha and ci['conclusion']=='success' and ci['attempt']==2
before=(d/'application-version.json').read_bytes();blocked=json.loads(before)
assert blocked['gate']=='BLOCKED' and blocked['blockers']==['EXACT_COMMIT_CI_NOT_SUCCESSFUL'] and blocked['lambdaArtifacts']==[]
assert not (d/'application-version-after-ci.json').exists() and not (d/'actual-config.json').exists()
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 assert not (p/(name+'.exit')).exists(),'NO_READ_STEP_REPLAY'
 (p/(name+'.command.json')).write_text(json.dumps(args,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as o,(p/(name+'.stderr.log')).open('w') as e:q=subprocess.run(args,env=env,stdout=o,stderr=e)
 (p/(name+'.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
call('default-19-after-ci',['node','scripts/collect-qa09-application-version.mjs',str(d/'application-version-after-ci.json')])
call('default-config-after-ci',['node','scripts/qa09-account-read-config.mjs',str(d/'qa09-deployment-inputs.json'),str(d/'application-version-after-ci.json'),str(d/'actual-config.json')])
assert (d/'application-version.json').read_bytes()==before
v=json.loads((d/'application-version-after-ci.json').read_text());assert v['gate']=='PASS' and len(v['lambdaArtifacts'])==19
out={'gate':'PASS','scope':'NEW_READ_ONLY_19_ARTIFACT_READ_AFTER_CI_PREREQUISITE_CLOSURE','sourceCommit':sha,'originalGate':'BLOCKED','originalBlocker':'EXACT_COMMIT_CI_NOT_SUCCESSFUL','ciAttempt':2,'originalReceiptSha256':hashlib.sha256(before).hexdigest(),'recoveryReceiptSha256':hashlib.sha256((d/'application-version-after-ci.json').read_bytes()).hexdigest(),'ciReceiptSha256':hashlib.sha256((p/'ci-run.json').read_bytes()).hexdigest(),'originalBytesUnchanged':True,'newBusinessFixtures':0,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(d/'after-ci-recovery-binding.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
