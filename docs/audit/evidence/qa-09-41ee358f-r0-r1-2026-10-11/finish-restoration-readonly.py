"""After default-off proof, only read database capacity and independently audit owned empty prefix."""
import json,hashlib,subprocess,datetime
from pathlib import Path
root=Path(__file__).parent;p=root/'restore';v=json.loads((p/'restore-completion.json').read_text());assert v['gate']=='PASS'
for n,h in v['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
assert not (p/'post-restoration-readonly.json').exists()
def call(name,args):
 assert not (p/(name+'.readonly.exit')).exists()
 (p/(name+'.readonly.command.json')).write_text(json.dumps(args)+'\n')
 with (p/(name+'.readonly.stdout.log')).open('w') as o,(p/(name+'.readonly.stderr.log')).open('w') as e:q=subprocess.run(args,stdout=o,stderr=e)
 (p/(name+'.readonly.exit')).write_text(str(q.returncode)+'\n');print(name,q.returncode,flush=True);assert q.returncode==0
call('capacity',['node',str(root/'capacity-readonly.mjs'),str(p/'capacity-before.json')])
call('capacity-gate',['python3',str(root/'capacity-gate.py'),str(p)])
call('audit-empty',['node',str(p/'audit-empty.mjs')])
assert json.loads((p/'capacity-before-gate.json').read_text())['gate']=='PASS' and json.loads((p/'database-empty-audit.json').read_text())['gate']=='PASS'
files=['restore-completion.json','actual-config.json','capacity-before.json','capacity-before-gate.json','database-empty-audit.json']
out={'gate':'PASS','scope':'RESTORED_DEFAULT_OFF_WITH_FRESH_READ_ONLY_CAPACITY_AND_OWN_EMPTY_AUDIT','sourceCommit':v['sourceCommit'],'runId':v['runId'],'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'newBusinessFixtures':0,'newBusinessRequests':0,'budgetScope':'STATIC_AND_READ_ONLY_SNAPSHOT_NOT_NEW_LOAD','bindings':{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in files},'p95Accepted':False,'fullQa09Accepted':False}
(p/'post-restoration-readonly.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out),flush=True)
