"""Resume only a stopped pre-business login wait; preserve failure and never replay business."""
import pathlib,json,subprocess,os,sys,hashlib
root=pathlib.Path(__file__).parent;mode=sys.argv[1];assert mode in ['r0','r1'];p=root/mode;q=p/'auth-resume';q.mkdir(exist_ok=True)
sha='88d9f0a5a734aacf0aef6af69c5a4985baacfe84'
assert (p/'pipeline.exit').exists() and int((p/'pipeline.exit').read_text())!=0,'ORIGINAL_PIPELINE_MUST_HAVE_STOPPED'
assert int((p/'renewable-session.pipeline.exit').read_text())!=0
assert any(x in (p/'renewable-session.pipeline.stderr.log').read_text() for x in ['RENEWABLE_SSO_REQUIRED_BEFORE_NEW_FIXTURES','ROLE_CLEANUP_MARGIN_REQUIRED'])
assert not any((p/n).exists() for n in ['sample.json','business-window.json','business.pipeline.command.json','business.pipeline.exit']),'NO_BUSINESS_OR_FIXTURE_REPLAY'
for n in ['wait-success','bind-deployment','cdk-diff','hosted-verify','19-artifacts','actual-config','capacity','capacity-gate']:assert int((p/(n+'.pipeline.exit')).read_text())==0
binding=json.loads((p/'deployment-input-binding.json').read_text());assert binding['gate']=='PASS' and binding['sourceCommit']==sha
for n,h in binding['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,'DEPLOYMENT_BINDING_DRIFT'
if mode=='r1':
 c=json.loads((root/'r0/unit-completion.json').read_text());assert c['gate']=='PASS' and c['sourceCommit']==sha
 for n,h in c['bindings'].items():assert hashlib.sha256((root/'r0'/n).read_bytes()).hexdigest()==h
run=str(binding['runId']);env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run}
def call(n,args):
 assert not (q/(n+'.exit')).exists(),'NO_RESUME_STEP_REPLAY'
 (q/(n+'.command.json')).write_text(json.dumps(args)+'\n')
 with (q/(n+'.stdout.log')).open('w') as o,(q/(n+'.stderr.log')).open('w') as e:c=subprocess.run(args,env=env,stdout=o,stderr=e).returncode
 (q/(n+'.exit')).write_text(str(c)+'\n');print(n,c,flush=True);assert c==0,n
call('remote-head',['gh','api','repos/inrust/food-digester-platform/commits/main','--jq','.sha'])
assert (q/'remote-head.stdout.log').read_text().strip()==sha
call('runtime',['node','scripts/collect-qa09-application-version.mjs',str(q/'runtime.json'),'--runtime-only'])
a=json.loads((p/'application-version.json').read_text());b=json.loads((q/'runtime.json').read_text());assert b['applicationVersionGate']=='PASS' and len(b['lambdaArtifacts'])==19
old={x['name']:x for x in a['lambdaArtifacts']}
for x in b['lambdaArtifacts']:
 for k in ['codeSha256','revisionId']:assert x[k]==old[x['name']][k],'RUNTIME_DRIFT_AFTER_LOGIN_TIMEOUT'
assert a['gate']=='PASS' and a['sourceCommit']==sha and all(x['matches'] is True for x in a['lambdaArtifacts'])
(q/'bound-byte-version.json').write_text(json.dumps(a,indent=2)+'\n')
(q/'runtime-binding.json').write_text(json.dumps({'gate':'PASS','scope':'PRIOR_VERIFIED_BYTES_WITH_FRESH_IDENTICAL_19_REVISIONS','bindings':{str(p/'application-version.json'):hashlib.sha256((p/'application-version.json').read_bytes()).hexdigest(),'runtime.json':hashlib.sha256((q/'runtime.json').read_bytes()).hexdigest()}},indent=2)+'\n')
call('actual-config',['node','scripts/qa09-account-read-config.mjs',str(p/'qa09-deployment-inputs.json'),str(q/'bound-byte-version.json'),str(q/'actual-config.json')])
call('capacity',['node',str(root/'capacity-readonly.mjs'),str(q/'capacity-before.json')])
call('capacity-gate',['python3',str(root/'capacity-gate.py'),str(q)])
call('renewable-session',['python3',str(root/'await-renewable-session.py'),str(q.relative_to(root))])
assert json.loads((q/'renewable-session-gate.json').read_text())['gate']=='PASS'
(p/'renewable-session-gate.json').write_bytes((q/'renewable-session-gate.json').read_bytes())
call('business',['python3',str(root/'run-business.py'),str(p)])
call('finish-unit',['python3',str(root/'finish-unit.py'),mode])
