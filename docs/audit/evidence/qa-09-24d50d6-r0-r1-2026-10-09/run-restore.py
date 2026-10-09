"""Restore defaults after byte-bound owned cleanup; no new business fixtures."""
import sys,os,json,subprocess,hashlib,shutil,datetime
from pathlib import Path
root=Path(__file__).parent;p=root/'restore';run=sys.argv[1];cleanupOnly=sys.argv[2:]==['--cleanup-only-r0'];assert len(sys.argv)==(3 if cleanupOnly else 2);sha='24d50d6c3a9000c629d8255f78ea8d57a9d5b3f7'
prior=root/('r0' if cleanupOnly else 'r1');closureName='cleanup-only-completion.json' if cleanupOnly else 'unit-completion.json';v=json.loads((prior/closureName).read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
if cleanupOnly:assert v['stageGate']=='FAIL' and v['cleanup']=='PASS' and not (root/'r1/dispatch.exit').exists()
for n,h in v['bindings'].items():assert hashlib.sha256((prior/n).read_bytes()).hexdigest()==h
assert not (p/'restore-completion.json').exists()
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 assert not (p/(name+'.pipeline.exit')).exists(),'NO_STEP_REPLAY'
 (p/(name+'.pipeline.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.pipeline.stdout.log')).open('w') as o,(p/(name+'.pipeline.stderr.log')).open('w') as e:q=subprocess.run(args,env=env,stdout=o,stderr=e)
 (p/(name+'.pipeline.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0,name
call('wait-success',['gh','run','watch',run,'--exit-status','--interval','30'])
call('bind-deployment',['python3',str(root/'bind-unit-deployment.py'),'restore',run])
call('cdk-diff',['python3',str(root/'collect-cdk-diff.py'),'restore',run])
call('hosted-verify',['python3',str(root/'collect-hosted-verify.py'),'restore',run])
source=prior/'application-version.json';assert not (p/'application-version.json').exists();shutil.copyfile(source,p/'application-version.json')
(p/'artifact-reuse-origin.json').write_text(json.dumps({'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'SAME_SHA_ZIP_BYTES_REUSE_ONLY_FRESH_19_CONFIGS'},indent=2)+'\n')
call('19-artifacts',['node','scripts/collect-qa09-application-version.mjs',str(p/'application-version.json'),'--retry-unverified'])
call('actual-config',['node','scripts/qa09-account-read-config.mjs',str(p/'qa09-deployment-inputs.json'),str(p/'application-version.json'),str(p/'actual-config.json')])
a=json.loads((p/'actual-config.json').read_text());assert a['gate']=='PASS' and a['config']['preconnect']=='false' and a['config']['accountReadCandidate']=='false' and a['config']['contractLoadDetail']=='false'
before=json.loads(source.read_text());after=json.loads((p/'application-version.json').read_text());old={a['name']:a for a in before['lambdaArtifacts']}
for x in after['lambdaArtifacts']:
 assert x['codeSha256']==old[x['name']]['codeSha256'],'RESTORE_CODE_DRIFT'
 if x['name']!='fdp-test-api':assert x['revisionId']==old[x['name']]['revisionId'],'RESTORE_NON_API_REVISION_DRIFT'
files=['deployment-input-binding.json','cdk-diff-summary.json','application-version.json','actual-config.json']
result={'gate':'PASS','scope':'SAME_SHA_RESTORE_DEFAULT_OFF_AFTER_R0_FAILED_STAGE_OWN_CLEANUP' if cleanupOnly else 'SAME_SHA_RESTORE_DEFAULT_OFF_AFTER_R1_OWN_CLEANUP','sourceCommit':sha,'runId':run,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'newFixtures':0,'contractLoadDetail':False,'accountReadCandidate':False,'authenticatedPreconnect':False,'engineCpu':True,'all19CodeUnchanged':True,'nonApiRevisionsUnchanged':True,'bindings':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in files},'predecessorClosureSha256':hashlib.sha256((prior/closureName).read_bytes()).hexdigest(),'fullQa09Accepted':False,'p95Accepted':False}
(p/'restore-completion.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
