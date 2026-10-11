"""Evaluate only known argument expressions, never calls any external command."""
import ast,json,hashlib
from pathlib import Path
root=Path(__file__).resolve().parent.parent;sha='bc95e9671a0bfb69effa95ad7c315b375199f132'
planned=json.loads((root/'preflight/planned-inputs.json').read_text());rows=[];bindings={}
def expression(path,name):
 b=path.read_bytes();bindings[str(path.relative_to(root))]=hashlib.sha256(b).hexdigest();tree=ast.parse(b)
 matches=[n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets)]
 assert len(matches)==1;return compile(ast.Expression(matches[0]),str(path),'eval')
cli=expression(root/'dispatch-unit.py','args')
for mode in ['r0','r1','restore']:
 args=eval(cli,{'__builtins__':{},'str':str},{'mode':mode,'sha':sha})
 assert args[:6]==['gh','workflow','run','deploy-test.yml','--ref','main']
 assert all(args[i]=='-f' for i in range(6,len(args),2))
 params=dict(v.split('=',1) for v in args[7::2])
 expected={'expected_commit':sha,'engine_cpu_diagnosis':'true','authenticated_preconnect':str(mode!='restore').lower(),'account_read_candidate':str(mode!='restore').lower(),'contract_load_detail':str(mode!='restore').lower(),'contract_public_boundaries':str(mode!='restore').lower(),'contract_observer_cost':str(mode=='r1').lower(),'rollout_phase':'immediate'}
 assert params==expected
 if mode!='restore':
  p=planned[mode];assert p['sourceCommit']==p['expectedCommit']==sha and p['accountReadCandidate'] is True and p['contractObserverCost']==(mode=='r1') and p['memoryMiB']==512 and p['poolMax']==1 and p['connectionBudget']==70 and p['maxConcurrency']==6
  flags=eval(expression(root/mode/'check-unit.py','flags'),{'__builtins__':{}},{'mode':mode})
  assert ('--observer-cost' in flags)==(mode=='r1') and '--contract-public-boundaries' in flags and '--authenticated-preconnect' in flags
  text=(root/mode/'collect-correlations.py').read_text();assert "if p.name=='r1' and name.endswith('-patch'):flags=flags+['--observer-cost']" in text
 rows.append({'mode':mode,'dispatchInputs':params,'gate':'PASS'})
assert planned['restore']['contractObserverCost'] is False and planned['restore']['accountReadCandidate'] is False
out=root/'preflight/helper-input-check.json';assert not out.exists();out.write_text(json.dumps({'gate':'LOCAL_PREFLIGHT_HELPER_CHECK_PASS','scope':'OFFLINE_ARGUMENTS_ONLY_NO_CLOUD_EXECUTION','sourceCommit':sha,'rows':rows,'bindings':bindings},indent=2)+'\n');print('helper inputs PASS; no external commands')
