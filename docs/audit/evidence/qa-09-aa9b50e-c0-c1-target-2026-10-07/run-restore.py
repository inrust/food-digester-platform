"""Restore candidate false only after both units and independent own cleanup close."""
import json,sys,subprocess,os,hashlib,shutil
from pathlib import Path
root=Path(__file__).parent;p=root/'restore';run=sys.argv[1];assert run.isdigit();sha='aa9b50eb010e2a1735084be587613431e6664ed3'
c0=root/'c0';v=json.loads((c0/'unit-completion.json').read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
for f,h in v['bindings'].items():assert hashlib.sha256((c0/f).read_bytes()).hexdigest()==h
c1=root/'c1';closure=c1/'unit-completion.json'
if closure.exists():
 v=json.loads(closure.read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
 for f,h in v['bindings'].items():assert hashlib.sha256((c1/f).read_bytes()).hexdigest()==h
 c1Closure='PASS'
elif '--cleanup-only' in sys.argv:
 if (c1/'sample.json').exists():
  child=json.loads((c1/'sample.json').read_text());parent=json.loads((c1/'sample.json.fixtures.json').read_text());assert child['cleanupComplete'] and all(c['result']=='PASS' for c in child['cleanup']) and parent['gate']=='PASS' and all(c['result']=='PASS' for c in parent['cleanup'])
  assert json.loads((c1/'database-empty-audit.json').read_text())['gate']=='PASS';c1Closure='CLEANED_TARGET_GATE_BLOCKED'
 else:
  assert not (c1/'sample.json.fixtures.json').exists() and not (c1/'business-window.json').exists(),'NO_UNPROVEN_PARTIAL_FIXTURE'
  assert json.loads((c1/'deployment-input-binding.json').read_text())['gate']=='PASS';c1Closure='NO_FIXTURE_PREBUSINESS_BLOCKED'
else:raise AssertionError('C1_CLOSURE_REQUIRED_OR_EXPLICIT_CLEANUP_ONLY')
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 assert not (p/(name+'.exit')).exists(),'NO_REPLAY_STEP'
 (p/(name+'.command.json')).write_text(json.dumps(args,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as out,(p/(name+'.stderr.log')).open('w') as err:code=subprocess.run(args,stdout=out,stderr=err,env=env).returncode
 (p/(name+'.exit')).write_text(str(code)+'\n');print(name,code,flush=True);assert code==0,name
call('wait-success',['gh','run','watch',run,'--exit-status','--interval','30'])
call('bind-deployment',['python3',str(root/'bind-unit-deployment.py'),'restore',run])
call('collect-diff',['python3',str(root/'collect-cdk-diff.py'),'restore',run])
source=root/'c1/application-version.json';dest=p/'application-version.json';assert not dest.exists();shutil.copyfile(source,dest)
(p/'artifact-reuse-origin.json').write_text(json.dumps({'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'IMMUTABLE_MATCHED_CODE_SHA_BUCKET_KEY_BYTES_ONLY_FRESH_19_CONFIG_READS'},indent=2)+'\n')
call('collection',['node','scripts/collect-qa09-application-version.mjs',str(dest),'--retry-unverified'])
v=json.loads(dest.read_text());original=json.loads(source.read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha and len(v['lambdaArtifacts'])==19
for a in original['lambdaArtifacts']:
 b=next(b for b in v['lambdaArtifacts'] if b['name']==a['name']);assert b['matches'] and all(a[k]==b[k] for k in ['codeSha256','artifactSha256','s3Key','s3Bucket','runtime'])
 if a['name']!='fdp-test-api':assert a['revisionId']==b['revisionId'],'NON_API_DRIFT'
bindings={f:hashlib.sha256((p/f).read_bytes()).hexdigest() for f in ['deployment-input-binding.json','api-config.json','api-concurrency.json','cdk-diff-summary.json','application-version.json']}
(p/'restore-gate.json').write_text(json.dumps({'gate':'PASS','scope':'SAME_SHA_CANDIDATE_FALSE_AND_19_BYTES_BOUND_RESTORE','sourceCommit':sha,'runId':run,'lambdaCount':19,'c1Closure':c1Closure,'authenticatedPreconnect':False,'bindings':bindings,'fullQa09Accepted':False,'p95Accepted':False},indent=2)+'\n')
print('restore PASS',flush=True)
