"""Sequential local checks with exact command/exit logs; no cloud writes."""
import subprocess,json,sys
from pathlib import Path
p=Path(__file__).parent
mode=p.name
assert mode in ['off','on']
flags=['--account-phases','--client-preparation','--runtime-assembly']+(['--engine-cpu'] if mode=='on' else [])
def run(name,args):
 (p/(name+'.command.json')).write_text(json.dumps(args,ensure_ascii=False,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as out,(p/(name+'.stderr.log')).open('w') as err:
  code=subprocess.run(args,stdout=out,stderr=err).returncode
 (p/(name+'.exit')).write_text(str(code)+'\n');print(name,code,flush=True)
 return code
for group in ['baseline','sampling']:
 args=['node','scripts/check-qa09-contract-phases.mjs',str(p/'sample.json'),str(p/(group+'-patch.json')),str(p/(group+'-audit.json'))]
 extra=['--cold-sampling'] if group=='sampling' else []
 assert run(group+'-phases',args+[str(p/(group+'-phases.json'))]+flags+extra)==0
 name='cold-phases' if group=='sampling' else 'baseline-cold-phases'
 code=run(name,args+[str(p/(name+'.json'))]+flags+extra+['--require-cold-conflict'])
 analysis='cold-analysis' if group=='sampling' else 'baseline-cold-analysis'
 if code==0:
  assert run(analysis,['node','scripts/analyze-qa09-account-phases.mjs',str(p/'sample.json'),str(p/(group+'-patch.json')),str(p/(group+'-audit.json')),str(p/(analysis+'.json')),'--client-preparation','--runtime-assembly']+(['--engine-cpu'] if mode=='on' else [])+extra)==0
 else:
  assert 'COLD_CONFLICT_REQUIRED' in (p/(name+'.stderr.log')).read_text()
  (p/(analysis+'.json')).write_text(json.dumps({'gate':'NOT_RUN','reason':'COLD_CONFLICT_NOT_OBSERVED','p95Accepted':False},indent=2)+'\n')
assert run('verify-target',['node','--import','tsx',str(p/'verify-target.mjs')])==0
assert run('analyze-runtime',['node',str(p/'analyze-runtime.mjs')])==0
