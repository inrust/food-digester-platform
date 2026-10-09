"""Local diagnostics on original bounded samples only; cannot admit R1 or upgrade failed wrapper."""
import subprocess,json,hashlib
from pathlib import Path
root=Path(__file__).parent;p=root/'r0';rows=[];bindings={}
assert json.loads((p/'sample.json.gate.json').read_text())['gate']=='FAIL'
flags=['--account-phases','--client-preparation','--client-split','--contract-load-split','--contract-load-detail','--runtime-assembly','--engine-cpu','--authenticated-preconnect']
def call(name,args):
 assert not (p/(name+'.exit')).exists()
 (p/(name+'.command.json')).write_text(json.dumps(args)+'\n');q=subprocess.run(args,capture_output=True,text=True)
 for suffix,b in [('stdout.log',q.stdout),('stderr.log',q.stderr),('exit',str(q.returncode)+'\n')]: (p/(name+'.'+suffix)).write_text(b)
 rows.append({'name':name,'exitCode':q.returncode});print(name,q.returncode,flush=True);return q.returncode
for group in ['baseline','sampling']:
 extra=['--cold-sampling'] if group=='sampling' else []
 args=['node','scripts/check-qa09-contract-phases.mjs',str(p/'sample.json'),str(p/(group+'-patch.json')),str(p/(group+'-audit.json'))]
 call(group+'-phases',args+[str(p/(group+'-phases.json'))]+flags+extra)
 cold=call(group+'-cold-phases',args+[str(p/(group+'-cold-phases.json'))]+flags+extra+['--require-cold-conflict'])
 if cold==0:
  call(group+'-cold-analysis',['node','scripts/analyze-qa09-account-phases.mjs',str(p/'sample.json'),str(p/(group+'-patch.json')),str(p/(group+'-audit.json')),str(p/(group+'-cold-analysis.json'))]+flags[1:]+extra)
for name in ['sample.json','sample.json.gate.json','baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json','connection-budget-gate.json']:
 bindings[name]=hashlib.sha256((p/name).read_bytes()).hexdigest()
(root/'failed-r0-diagnostics.json').write_text(json.dumps({'gate':'PARTIAL','scope':'ORIGINAL_R0_BOUNDED_SAMPLES_LOCAL_DIAGNOSTICS_ONLY','sourceCommit':'f7abb0670398a1254fcf45755f077b41f4fcd4c0','originalExecutionGate':'FAIL','r1Gate':'NOT_RUN','commands':rows,'bindings':bindings,'p95Accepted':False,'fullQa09Accepted':False},indent=2)+'\n')
