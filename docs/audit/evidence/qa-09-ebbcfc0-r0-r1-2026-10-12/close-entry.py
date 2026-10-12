"""Local entry proof only; no deployment or business mutation."""
import json,hashlib,datetime,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent;sha='ebbcfc0ee31673b3332b217ca757e6aa1ea6013d';run='38184960795';bindings={}
assert subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()==sha
assert not (root/'preflight/entry-completion.json').exists()
def read(n):
 b=(root/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
ci=read('preflight/ci-run.json');assert ci['headSha']==sha and ci['status']=='completed' and ci['conclusion']=='success' and ci['attempt']==2
for n in ['default-off/deployment-input-binding.json','default-off/application-version-after-ci.json','default-off/actual-config.json','default-off/hosted-verify-'+run+'.json']:
 v=read(n);assert v['gate']=='PASS' and v['sourceCommit']==sha
v=read('default-off/application-version-after-ci.json');assert len(v['lambdaArtifacts'])==19
config=read('default-off/actual-config.json')['config'];assert config['contractObserverCost']=='false'
assert read('preflight/capacity-before-gate.json')['gate']=='PASS'
entry=read('preflight/prestart-entry-gate.json');assert entry['gate']=='PASS' and entry['sourceCommit']==sha
for n,h in entry['bindings'].items():assert hashlib.sha256((root/'preflight'/n).read_bytes()).hexdigest()==h
assert read('preflight/renewable-session-gate.json')['gate']=='PASS'
helperProof=read('preflight/helper-input-check-final-v2.json');assert helperProof['gate']=='LOCAL_PREFLIGHT_HELPER_CHECK_PASS'
for name,digest in helperProof['bindings'].items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,'HELPER_SOURCE_DRIFT'
for name,digest in helperProof['repositoryDependencies'].items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==digest,'READER_DEPENDENCY_DRIFT'
blocked=read('default-off/application-version.json');assert blocked['gate']=='BLOCKED' and blocked['blockers']==['EXACT_COMMIT_CI_NOT_SUCCESSFUL'] and blocked['lambdaArtifacts']==[]
recovery=read('default-off/after-ci-recovery-binding.json');assert recovery['gate']=='PASS' and recovery['originalReceiptSha256']==bindings['default-off/application-version.json'] and recovery['recoveryReceiptSha256']==bindings['default-off/application-version-after-ci.json']
planned=read('preflight/planned-inputs.json');assert planned['r0']['sourceCommit']==planned['r1']['sourceCommit']==sha and all(planned[m]['accountReadCandidate'] is True for m in ['r0','r1']) and planned['r0']['contractObserverCost'] is False and planned['r1']['contractObserverCost'] is True
args=['python3',str(root/'check-implementation-seal.py')]
q=subprocess.run(args,capture_output=True,text=True);assert q.returncode==0,q.stderr
(root/'preflight/implementation-check.json').write_text(q.stdout);assert read('preflight/implementation-check.json')['gate']=='LOCAL_LOG_READ_BUDGET_PASS'
assert planned['manifestRequirements']['requireOwnedBoundaries'] is True
helpers={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.suffix in ['.py','.mjs']}
(root/'preflight/entry-scope.json').write_text(json.dumps({'gate':'PASS','sourceCommit':sha,'entryHelpers':helpers,'unknownHistoricalPlansReplayed':False,'newBusinessFixtures':0},indent=2)+'\n');read('preflight/entry-scope.json')
(root/'preflight/entry-completion.json').write_text(json.dumps({'gate':'PASS','scope':'SAME_SHA_CI_DEFAULT_OFF_19_ARTIFACTS_RENEWABLE_SESSION_CAPACITY_AND_PRESTART_ENTRY_ONLY','sourceCommit':sha,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bindings':bindings,'p95Accepted':False,'fullQa09Accepted':False},indent=2)+'\n');print('entry PASS')
