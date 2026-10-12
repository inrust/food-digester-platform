"""Offline syntax, exact inputs, single recovery and new reader dependency proof."""
import ast,hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent;sha='ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'
h=lambda b:hashlib.sha256(b).hexdigest()
originPath=root/'preflight/helper-origins.json';origins=json.loads(originPath.read_text())
for row in origins['helpers']:
 assert h(Path(row['origin']).read_bytes())==row['originSha256']
 row['sha256']=h((root/row['path']).read_bytes())
for p in root.rglob('*'):
 if p.suffix=='.py':ast.parse(p.read_text())
 if p.suffix=='.mjs':subprocess.run(['node','--check',str(p)],check=True,capture_output=True)
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
 assert "'--exact-sha256',firstHash" in s and 'check-qa09-log-read-budget.mjs' in s
 assert "'--observer-cost','--owned-boundaries'" in s
 assert s.count("name+'-exact'")==1 and 'first.read_bytes()==firstBytes' in s
 for name in ['collect-initial-phases.py','collect-negative-phases.py']:
  s=(root/mode/name).read_text();assert 'from qa09_log_read import LogReader' in s and 'timeout=45' not in s and 'reader.finish()' in s
 s=(root/mode/'verify-target.mjs').read_text();assert s.count('verifyReadBudget(')==4 and "ownedBoundaries: dir.endsWith('/r1')" in s
assert "'logReadBudgetGate':'PASS'" in (root/'complete-unit.py').read_text()
paths=['scripts/collect-qa09-contract-correlation.py','scripts/qa09_log_read.py','scripts/qa09_observer_cost.py','scripts/check-qa09-log-read-budget.mjs','scripts/check-qa09-contract-phases.mjs','scripts/run-qa09-nonactive-target.mjs','scripts/qa09-ten-device-bridge.mjs','scripts/qa09-nonactive-cleanup.mjs']
sources={p:h(Path(p).read_bytes()) for p in paths}
for p,digest in sources.items():assert h(subprocess.check_output(['git','show',sha+':'+p]))==digest,p
planned=json.loads((root/'preflight/planned-inputs.json').read_text());assert planned['manifestRequirements']['requireOwnedBoundaries'] is True
assert planned['r0']['sourceCommit']==planned['r1']['sourceCommit']==sha
suffix={'--final':'-final','--final-v2':'-final-v2'}.get(sys.argv[1] if sys.argv[1:] else '', '')
originOutput=root/('preflight/helper-origins'+suffix+'.json')
if suffix:assert not originOutput.exists()
originOutput.write_text(json.dumps(origins,indent=2)+'\n')
bindings={str(p.relative_to(root)):h(p.read_bytes()) for p in sorted(root.rglob('*')) if p.suffix in ['.py','.mjs']}
output=root/('preflight/helper-input-check'+suffix+'.json');assert not output.exists()
output.write_text(json.dumps({'gate':'LOCAL_PREFLIGHT_HELPER_CHECK_PASS','sourceCommit':sha,'scope':'OFFLINE_INPUTS_SYNTAX_SERIAL_BOUNDED_READ_AND_SOURCE_BYTES_ONLY','rows':rows,'originHelpersVerified':len(origins['helpers']),'bindings':bindings,'repositoryDependencies':sources,'noCloudActions':True},indent=2)+'\n')
print(json.dumps({'gate':'LOCAL_PREFLIGHT_HELPER_CHECK_PASS','helpers':len(bindings),'dependencies':len(sources)}))
