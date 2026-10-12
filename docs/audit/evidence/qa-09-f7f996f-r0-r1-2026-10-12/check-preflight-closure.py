"""Offline verification of same-SHA default reads and an unpublished QA-only entry block."""
from pathlib import Path
import hashlib,json,subprocess,ast
root=Path(__file__).resolve().parent;repo=root.parents[3];sha='f7f996f278877cb57fc9d400f8f1d24b6ff5ff48'
h=lambda b:hashlib.sha256(b).hexdigest()
def read(n):return json.loads((root/n).read_bytes())
ci=read('preflight/ci-run.json');assert ci['headSha']==sha and ci['status']=='completed' and ci['conclusion']=='success' and ci['attempt']==1
for n in ['default-off/deployment-input-binding.json','default-off/actual-config.json','default-off/hosted-verify-38195152567.json','default-off/application-version.json']:
 v=read(n);assert v['gate']=='PASS' and v['sourceCommit']==sha,n
version=read('default-off/application-version.json');assert len(version['lambdaArtifacts'])==19
assert all(v['artifactSha256']==v['codeSha256'] for v in version['lambdaArtifacts'])
assert version['pendingDeployment']['status']=='completed' and version['pendingDeployment']['conclusion']=='success'
config=read('default-off/actual-config.json')['config']
assert all(config[k]=='false' for k in ['preconnect','accountReadCandidate','contractLoadDetail','contractPublicBoundaries','contractObserverCost'])
assert config['engineCpu']=='true' and config['memory']==512 and config['pool']=='1'
assert read('default-off/actual-config.json')['concurrency']['ReservedConcurrentExecutions']==12
final=read('final-default-readonly.json');assert final['gate']=='PASS' and final['api']['revisionId']==config['revisionId']
assert final['newBusinessFixtures']==final['newBuilds']==final['newBusinessRequests']==final['newDeployments']==0
for mode in ['r0','r1','restore']:
 assert not (root/mode/'dispatch.exit').exists() and not (root/mode/'sample.json').exists()
assert not list(root.rglob('*.started.json')) and not (root/'preflight/entry-completion.json').exists()
helper=read('preflight/helper-input-check.json');assert helper['gate']=='LOCAL_PREFLIGHT_HELPER_CHECK_PASS' and helper['sourceCommit']==sha
for n,expected in helper['bindings'].items():assert h((root/n).read_bytes())==expected,n
for n,expected in helper['repositoryDependencies'].items():assert h(subprocess.check_output(['git','show',sha+':'+n],cwd=repo))==expected,n
sourceGap=read('preflight/source-gap-gate.json');assert sourceGap['gate']=='BLOCKED_BEFORE_R0_FIXTURES' and len(sourceGap['candidateDeltas'])==5
for row in sourceGap['candidateDeltas']:
 assert row['pushedSha256']==helper['repositoryDependencies'][row['path']]
 assert row['candidateSha256']==h((repo/row['path']).read_bytes())
assert sourceGap['helperProofSha256']==h((root/'preflight/helper-input-check.json').read_bytes())
historyFiles=0;historyBindings=0
for name,commit in [('qa-09-log-read-budget-2026-10-12','ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'),('qa-09-ebbcfc0-r0-r1-2026-10-12',sha),('qa-09-auxiliary-batches-2026-10-12',sha)]:
 old=repo/'docs/audit/evidence'/name;m=json.loads((old/'manifest.json').read_bytes())
 assert {str(p.relative_to(old)):h(p.read_bytes()) for p in old.rglob('*') if p.is_file() and p.name!='manifest.json'}==m['files']
 for n,wanted in m['bindings'].items():assert h(subprocess.check_output(['git','show',commit+':'+n],cwd=repo))==wanted
 historyFiles+=len(m['files']);historyBindings+=len(m['bindings'])
assert historyFiles==702 and historyBindings==28
assert subprocess.check_output(['git','diff',sha,'--','apps','packages','contracts','infra','.github','package.json','pnpm-lock.yaml'],cwd=repo)==b''
for p in root.rglob('*.py'):ast.parse(p.read_bytes(),filename=str(p))
print(json.dumps({'gate':'PASS','scope':'SAME_SHA_DEFAULT_19_ARTIFACTS_AND_PRE_FIXTURE_BLOCK_EVIDENCE_ONLY','sourceCommit':sha,'artifactCount':19,'frozenHelpers':len(helper['bindings']),'pushedQaDependencies':len(helper['repositoryDependencies']),'historicalFiles':historyFiles,'historicalCommittedBindings':historyBindings,'entryGate':'BLOCKED_BEFORE_R0_FIXTURES','r0':'NOT_RUN','r1':'NOT_RUN','newBuilds':0,'newBusinessFixtures':0,'restore':'NOT_REQUIRED','fullQa09Accepted':False,'p95Accepted':False}))
