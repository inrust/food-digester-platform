"""Read local receipts only; omit all credential/identity/business contents."""
from pathlib import Path
import json,sys,datetime
root=Path(__file__).parent;p=root/sys.argv[1];out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':p.name,'receipts':[]}
for name in ['capacity-before.json','renewable-session-gate.json','sample.json.fixtures.json','sample.json','sample.json.gate.json','database-empty-audit.json','baseline-phases.json','sampling-phases.json','unit-completion.json']:
 f=p/name
 if not f.exists():continue
 try:x=json.loads(f.read_text())
 except ValueError:continue
 v={'file':name}
 for k in ['gate','prefix','cleanupComplete','finishedAt']:
  if k in x:v[k]=x[k]
 if 'checks' in x:v['checks']=len(x['checks']);v['failedChecks']=sum(c.get('result')=='FAIL' for c in x['checks'])
 if 'cleanup' in x and isinstance(x['cleanup'],list):v['cleanupEntries']=len(x['cleanup']);v['failedCleanup']=sum(c.get('result')=='FAIL' for c in x['cleanup'])
 if 'build' in x:v['build']={k:x['build'][k] for k in ['id','status'] if k in x['build']}
 out['receipts'].append(v)
print(json.dumps(out,ensure_ascii=False))
