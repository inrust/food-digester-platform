"""Continue only after verified recovery of the same read-only capacity Build."""
import pathlib,sys,json,subprocess,os,hashlib,datetime
root=pathlib.Path(__file__).parent;mode=sys.argv[1];assert mode=='r0';p=root/mode;q=p/'auth-resume';c=q/'capacity-recovery';c.mkdir(exist_ok=True)
assert int((q/'pipeline.exit').read_text())!=0 and int((q/'capacity.exit').read_text())!=0
assert 'AWS_batch-get-builds_CLI_FAILED' in (q/'capacity.stderr.log').read_text()
assert not any((p/n).exists() for n in ['sample.json','business-window.json','business-command.json']),'NO_BUSINESS_REPLAY'
for n in ['remote-head','runtime','actual-config']:assert int((q/(n+'.exit')).read_text())==0
b=json.loads((p/'deployment-input-binding.json').read_text());sha=b['sourceCommit'];assert sha=='88d9f0a5a734aacf0aef6af69c5a4985baacfe84'
for n,h in b['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
v=json.loads((q/'runtime-binding.json').read_text());assert v['gate']=='PASS'
for n,h in v['bindings'].items():
 f=pathlib.Path(n) if n.startswith('docs/') else q/n
 assert hashlib.sha256(f.read_bytes()).hexdigest()==h
r=json.loads((q/'capacity-recovered.json').read_text());old=json.loads((q/'capacity-before.json').read_text());assert r['gate']=='PASS' and r['build']['id']==old['build']['id'] and r['newBuilds']==0 and r['result']['transactionReadOnly'] is True and r['result']['writes']==0
age=datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(r['build']['endTime']);assert datetime.timedelta(0)<=age<datetime.timedelta(minutes=10),'FRESH_READONLY_CAPACITY_REQUIRED'
(c/'capacity-before.json').write_bytes((q/'capacity-recovered.json').read_bytes())
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':str(b['runId'])}
def call(n,args):
 assert not (c/(n+'.exit')).exists(),'NO_COMPLETED_STEP_REPLAY'
 (c/(n+'.command.json')).write_text(json.dumps(args)+'\n')
 with (c/(n+'.stdout.log')).open('w') as o,(c/(n+'.stderr.log')).open('w') as e:z=subprocess.run(args,env=env,stdout=o,stderr=e).returncode
 (c/(n+'.exit')).write_text(str(z)+'\n');print(n,z,flush=True);assert z==0,n
call('capacity-gate',['python3',str(root/'capacity-gate.py'),str(c)])
call('actual-config-fresh',['node','scripts/qa09-account-read-config.mjs',str(p/'qa09-deployment-inputs.json'),str(q/'bound-byte-version.json'),str(c/'actual-config.json')])
call('renewable-session',['python3',str(root/'await-renewable-session.py'),str(c.relative_to(root))])
(p/'renewable-session-gate.json').write_bytes((c/'renewable-session-gate.json').read_bytes())
call('business',['python3',str(root/'run-business.py'),str(p)])
call('finish-unit',['python3',str(root/'finish-unit.py'),mode])
