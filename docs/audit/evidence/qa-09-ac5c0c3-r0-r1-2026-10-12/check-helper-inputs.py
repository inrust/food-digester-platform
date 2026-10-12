"""Freeze exact fresh helpers, dispatched inputs and pushed QA dependencies before entry."""
from pathlib import Path
import ast,hashlib,json,subprocess,sys
root=Path(__file__).resolve().parent;repo=root.parents[3];sha='ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2'
h=lambda b:hashlib.sha256(b).hexdigest()
origins=json.loads((root/'preflight/helper-origins.json').read_bytes())
for row in origins['helpers']:
 assert h((repo/row['origin']).read_bytes())==row['originSha256'],'HISTORICAL_HELPER_DRIFT'
 assert h((root/row['path']).read_bytes())==row['sha256'],'PREPARED_HELPER_DRIFT:'+row['path']
source=(root/'dispatch-unit.py').read_text();tree=ast.parse(source)
expr=next(n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='args' for t in n.targets))
rows=[]
for mode in ['r0','r1','restore']:
 args=eval(compile(ast.Expression(expr),'<dispatch>','eval'),{'__builtins__':{},'str':str},{'sha':sha,'mode':mode})
 pairs=dict(args[i+1].split('=',1) for i,v in enumerate(args) if v=='-f')
 assert pairs=={'expected_commit':sha,'engine_cpu_diagnosis':'true','authenticated_preconnect':str(mode!='restore').lower(),'account_read_candidate':str(mode!='restore').lower(),'contract_load_detail':str(mode!='restore').lower(),'contract_public_boundaries':str(mode!='restore').lower(),'contract_observer_cost':str(mode=='r1').lower(),'rollout_phase':'immediate'}
 rows.append({'mode':mode,'inputs':pairs})
for mode in ['r0','r1']:
 s=(root/mode/'collect-correlations.py').read_text()
 assert 'ThreadPoolExecutor' not in s and 'concurrent.futures' not in s
 assert "'--exact-sha256',firstHash" in s and 'check-qa09-log-read-budget.mjs' in s and 'first.read_bytes()==firstBytes' in s
 for n in ['collect-initial-phases.py','collect-negative-phases.py']:
  s=(root/mode/n).read_text();assert "'python3','-I'" in s and 'scripts/collect-qa09-auxiliary-phases.py' in s and 'qa09_log_read import' not in s
 assert (root/mode/'verify-target.mjs').read_text().count('verifyReadBudget(')==4
s=(root/'finish-unit.py').read_text();assert s.count('scripts/check-qa09-auxiliary-read.mjs')==2
s=(root/'complete-unit.py').read_text();assert 'BOUNDED_OWN_AUXILIARY_READ_AND_SOURCE_BYTES_ONLY' in s
paths=['scripts/collect-qa09-contract-correlation.py','scripts/qa09_log_read.py','scripts/qa09_observer_cost.py','scripts/check-qa09-log-read-budget.mjs','scripts/check-qa09-contract-phases.mjs','scripts/run-qa09-nonactive-target.mjs','scripts/qa09-ten-device-bridge.mjs','scripts/qa09-nonactive-cleanup.mjs','scripts/collect-qa09-auxiliary-phases.py','scripts/check-qa09-auxiliary-read.mjs','scripts/qa09_auxiliary_read_test_driver.py','scripts/qa09-auxiliary-read.test.mjs','scripts/check-qa09-auxiliary-read.test.mjs','scripts/qa09-contract-windows-proof.mjs','scripts/qa09-contract-windows-proof.test.mjs','scripts/run-qa09-contract-windows-offline.mjs','packages/database/test/contract-windows-offline.test.ts']
sources={p:h((repo/p).read_bytes()) for p in paths}
for p,digest in sources.items():assert h(subprocess.check_output(['git','show',sha+':'+p],cwd=repo))==digest,p
planned=json.loads((root/'preflight/planned-inputs.json').read_bytes());assert planned['manifestRequirements']['requireOwnedBoundaries'] is True
assert planned['r0']['sourceCommit']==planned['r1']['sourceCommit']==sha
bindings={}
for p in sorted(root.rglob('*')):
 if p.suffix=='.py':ast.parse(p.read_bytes(),filename=str(p))
 elif p.suffix=='.mjs':subprocess.run(['node','--check',str(p)],check=True,capture_output=True)
 else:continue
 bindings[str(p.relative_to(root))]=h(p.read_bytes())
v={'gate':'LOCAL_PREFLIGHT_HELPER_CHECK_PASS','sourceCommit':sha,'scope':'OFFLINE_INPUTS_SYNTAX_BATCH_ENTRY_AND_SOURCE_BYTES_ONLY','rows':rows,'originHelpersVerified':len(origins['helpers']),'bindings':bindings,'repositoryDependencies':sources,'noCloudActions':True}
with (root/'preflight/helper-input-check.json').open('x') as f:f.write(json.dumps(v,indent=2)+'\n')
print(json.dumps({'gate':v['gate'],'helpers':len(bindings),'dependencies':len(sources)}))
