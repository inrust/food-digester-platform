"""Local entry proof only; no deployment or business mutation."""
import json,hashlib,datetime,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent;sha='5773ac9d7bad13d41c2d00e456f8b633fa939579';run='38122155867';bindings={}
assert subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()==sha
assert not (root/'preflight/entry-completion.json').exists()
def read(n):
 b=(root/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
ci=read('preflight/ci-run.json');assert ci['headSha']==sha and ci['status']=='completed' and ci['conclusion']=='success' and ci['attempt']==1
for n in ['default-off/deployment-input-binding.json','default-off/application-version.json','default-off/actual-config.json','default-off/hosted-verify-'+run+'.json']:
 v=read(n);assert v['gate']=='PASS' and v['sourceCommit']==sha
v=read('default-off/application-version.json');assert len(v['lambdaArtifacts'])==19
config=read('default-off/actual-config.json')['config'];assert config['contractObserverCost']=='false'
assert read('preflight/capacity-before-gate.json')['gate']=='PASS'
entry=read('preflight/prestart-entry-gate.json');assert entry['gate']=='PASS' and entry['sourceCommit']==sha
for n,h in entry['bindings'].items():assert hashlib.sha256((root/'preflight'/n).read_bytes()).hexdigest()==h
assert read('preflight/renewable-session-gate.json')['gate']=='PASS'
assert read('preflight/helper-input-check.json')['gate']=='LOCAL_PREFLIGHT_HELPER_CHECK_PASS'
planned=read('preflight/planned-inputs.json');assert planned['r0']['sourceCommit']==planned['r1']['sourceCommit']==sha and all(planned[m]['accountReadCandidate'] is True for m in ['r0','r1']) and planned['r0']['contractObserverCost'] is False and planned['r1']['contractObserverCost'] is True
args=['python3','docs/audit/evidence/qa-09-safe-cleanup-implementation-2026-10-11/check-local-seal.py','--check']
q=subprocess.run(args,capture_output=True,text=True);assert q.returncode==0,q.stderr
(root/'preflight/implementation-check.json').write_text(q.stdout);assert read('preflight/implementation-check.json')['gate']=='LOCAL_IMPLEMENTATION_PASS'
helpers={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.suffix in ['.py','.mjs']}
(root/'preflight/entry-scope.json').write_text(json.dumps({'gate':'PASS','sourceCommit':sha,'entryHelpers':helpers,'unknownHistoricalPlansReplayed':False,'newBusinessFixtures':0},indent=2)+'\n');read('preflight/entry-scope.json')
(root/'preflight/entry-completion.json').write_text(json.dumps({'gate':'PASS','scope':'SAME_SHA_CI_DEFAULT_OFF_19_ARTIFACTS_RENEWABLE_SESSION_CAPACITY_AND_PRESTART_ENTRY_ONLY','sourceCommit':sha,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bindings':bindings,'p95Accepted':False,'fullQa09Accepted':False},indent=2)+'\n');print('entry PASS')
