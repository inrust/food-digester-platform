"""Offline exact dispatch and schema2 collector argument validation. No cloud calls."""
from pathlib import Path
import ast,hashlib,json,subprocess
root=Path(__file__).parent;sha='41ee358fb92e4dae2ae4abba7eb9923996fe029b'
origins=json.loads((root/'preflight/helper-origins.json').read_text())
for row in origins['helpers']:
 assert hashlib.sha256(Path(row['origin']).read_bytes()).hexdigest()==row['originSha256']
 assert hashlib.sha256((root/row['path']).read_bytes()).hexdigest()==row['sha256']
for p in root.rglob('*'):
 if p.suffix=='.py':ast.parse(p.read_text())
 if p.suffix=='.mjs':subprocess.run(['node','--check',str(p)],check=True,capture_output=True)
source=(root/'dispatch-unit.py').read_text();tree=ast.parse(source)
expr=next(n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='args' for t in n.targets))
rows=[]
for mode in ['r0','r1','restore']:
 args=eval(compile(ast.Expression(expr),'<dispatch-args>','eval'),{'__builtins__':{},'str':str},{'sha':sha,'mode':mode})
 pairs=dict(args[i+1].split('=',1) for i,v in enumerate(args) if v=='-f')
 assert args[:7]==['gh','workflow','run','deploy-test.yml','--ref','main','-f']
 assert pairs=={'expected_commit':sha,'engine_cpu_diagnosis':'true','authenticated_preconnect':str(mode!='restore').lower(),'account_read_candidate':str(mode!='restore').lower(),'contract_load_detail':str(mode!='restore').lower(),'contract_public_boundaries':str(mode!='restore').lower(),'contract_observer_cost':str(mode=='r1').lower(),'rollout_phase':'immediate'}
 rows.append({'mode':mode,'dispatchInputs':pairs,'gate':'PASS'})
for mode in ['r0','r1']:
 for name in ['check-unit.py','collect-correlations.py']:assert "'--observer-cost','--owned-boundaries'" in (root/mode/name).read_text()
 assert "ownedBoundaries: dir.endsWith('/r1')" in (root/mode/'verify-target.mjs').read_text()
assert "contractObserverSchemaVersion" in (root/'bind-unit-deployment.py').read_text()
assert "'--owned-boundaries'" in (root/'compare-units.py').read_text()
assert json.loads((root/'preflight/planned-inputs.json').read_text())['manifestRequirements']['requireOwnedBoundaries'] is True
bindings={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.suffix in ['.py','.mjs']}
out={'gate':'LOCAL_PREFLIGHT_HELPER_CHECK_PASS','scope':'OFFLINE_ARGUMENTS_SYNTAX_AND_SCHEMA2_ONLY_NO_CLOUD_EXECUTION','sourceCommit':sha,'rows':rows,'originHelpersVerified':len(origins['helpers']),'bindings':bindings}
(root/'preflight/helper-input-check.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'gate':out['gate'],'helperCount':len(bindings)}))
