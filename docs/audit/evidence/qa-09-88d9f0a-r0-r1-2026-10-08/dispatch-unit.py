"""Dispatch exactly once after predecessor proof; no application/resource direct mutation."""
import json,subprocess,sys,hashlib,time,datetime
from pathlib import Path
root=Path(__file__).parent;mode=sys.argv[1];cleanupOnly=sys.argv[2:]==['--cleanup-only-r0'];assert len(sys.argv)==(3 if cleanupOnly else 2);assert not cleanupOnly or mode=='restore';assert mode in ['r0','r1','restore'];p=root/mode
sha='88d9f0a5a734aacf0aef6af69c5a4985baacfe84'
assert not (p/'dispatch.exit').exists(),'NO_REDISPATCH'
if mode=='r0':assert json.loads((root/'default-off/actual-config.json').read_text())['gate']=='PASS'
else:
 prior=root/('r0' if mode=='r1' or cleanupOnly else 'r1');closure=json.loads((prior/('cleanup-only-completion.json' if cleanupOnly else 'unit-completion.json')).read_text());assert closure['gate']=='PASS' and closure['sourceCommit']==sha
 if cleanupOnly:assert closure['stageGate']=='FAIL' and closure['cleanup']=='PASS' and not (root/'r1/dispatch.exit').exists()
 for n,h in closure['bindings'].items():assert hashlib.sha256((prior/n).read_bytes()).hexdigest()==h,'PREDECESSOR_BYTE_DRIFT'
head=json.loads(subprocess.check_output(['gh','api','repos/inrust/food-digester-platform/commits/main'],text=True));assert head['sha']==sha,'REMOTE_SOURCE_DRIFT'
query=['gh','run','list','--workflow','deploy-test.yml','--event','workflow_dispatch','--commit',sha,'--limit','8','--json','databaseId,status,createdAt,url']
before=json.loads(subprocess.check_output(query,text=True));(p/'dispatch-before.json').write_text(json.dumps(before,indent=2)+'\n');ids={r['databaseId'] for r in before}
args=['gh','workflow','run','deploy-test.yml','--ref','main','-f','expected_commit='+sha,'-f','engine_cpu_diagnosis=true','-f','authenticated_preconnect='+str(mode!='restore').lower(),'-f','account_read_candidate='+str(mode=='r1').lower(),'-f','rollout_phase=immediate']
(p/'dispatch.command.json').write_text(json.dumps(args,indent=2)+'\n');q=subprocess.run(args,capture_output=True,text=True,timeout=60);(p/'dispatch.stdout.log').write_text(q.stdout);(p/'dispatch.stderr.log').write_text(q.stderr);(p/'dispatch.exit').write_text(str(q.returncode)+'\n');assert q.returncode==0
for _ in range(24):
 fresh=[r for r in json.loads(subprocess.check_output(query,text=True)) if r['databaseId'] not in ids]
 if fresh:
  assert len(fresh)==1,'AMBIGUOUS_DISPATCH';(p/'dispatch-run.json').write_text(json.dumps({'sourceCommit':sha,'mode':mode,**fresh[0]},indent=2)+'\n');print(fresh[0]['databaseId'],flush=True);break
 time.sleep(5)
else:raise AssertionError('DISPATCH_RUN_NOT_OBSERVED_NO_REDISPATCH')
