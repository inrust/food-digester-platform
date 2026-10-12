"""Derive new local helpers; preserve frozen entry and failed original bytes."""
import ast, hashlib, json, subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
sha='ebbcfc0ee31673b3332b217ca757e6aa1ea6013d'
out=root/'preflight/local-import-recovery-inputs.json'
assert not out.exists()
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
entry=json.loads((root/'preflight/entry-scope.json').read_text())
for name,digest in entry['entryHelpers'].items():assert h(root/name)==digest
p=root/'r0'
assert (p/'collect-initial.closure.exit').read_text().strip()=='1'
assert 'ModuleNotFoundError: No module named \'qa09_log_read\'' in (p/'collect-initial.closure.stderr.log').read_text()
assert not (p/'initial-phases.json').exists() and not (p/'negative-phases.json').exists()
for name in ['sample.json','sample.json.fixtures.json','sample.json.gate.json','database-empty-audit.json','negative-get.json']:
 assert json.loads((p/name).read_text())['gate']=='PASS'
for name in ['audit-empty','negative-get','collect-correlations']:
 assert (p/(name+'.closure.exit')).read_text().strip()=='0'
derived=[]
def save(old,new,text):
 source=root/old;target=root/new;assert not target.exists()
 ast.parse(text);target.write_text(text)
 derived.append({'origin':old,'originSha256':h(source),'path':new,'sha256':h(target)})
for mode in ['r0','r1']:
 for kind in ['initial','negative']:
  old=f'{mode}/collect-{kind}-phases.py'
  text=(root/old).read_text()
  assert 'parents[4]' in text and 'parents[5]' not in text
  text=text.replace('parents[4]','parents[5]')
  seam="from qa09_log_read import LogReader\n"
  text=text.replace(seam,seam+"if sys.argv[1:]==['--check-import']:\n    print(json.dumps({'gate':'PASS','modulePath':str(Path(sys.modules['qa09_log_read'].__file__).resolve()),'readerSha256':hashlib.sha256(Path(sys.modules['qa09_log_read'].__file__).read_bytes()).hexdigest()}))\n    raise SystemExit(0)\n")
  save(old,f'{mode}/collect-{kind}-phases-entry-corrected.py',text)
old='finish-unit.py';text=(root/old).read_text()
for kind in ['initial','negative']:
 text=text.replace(f"p/'collect-{kind}-phases.py'",f"p/'collect-{kind}-phases-entry-corrected.py'")
save(old,'finish-unit-entry-corrected.py',text)
head,tail=text.split("call('collect-initial',",1)
head=head.split("call('audit-empty',",1)[0]
guards="""assert mode=='r0'
assert (p/'collect-initial.closure.exit').read_text().strip()=='1'
assert "ModuleNotFoundError: No module named 'qa09_log_read'" in (p/'collect-initial.closure.stderr.log').read_text()
assert not (p/'initial-phases.json').exists() and not (p/'negative-phases.json').exists()
for completed in ['audit-empty','negative-get','collect-correlations']:
 assert (p/(completed+'.closure.exit')).read_text().strip()=='0'
proof=json.loads((root/'preflight/local-import-recovery-inputs.json').read_text())
assert proof['gate']=='PASS' and proof['sourceCommit']==sha
import hashlib
for n,d in proof['bindings'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==d
"""
save(old,'finish-unit-local-import-recovery.py',head+guards+"call('collect-initial-recovery',"+tail)
text=(root/'run-unit.py').read_text().replace("root/'finish-unit.py'","root/'finish-unit-entry-corrected.py'")
save('run-unit.py','run-unit-entry-corrected.py',text)
tests=[]
for row in derived[:4]:
 args=['python3','-I',str((root/row['path']).resolve()),'--check-import']
 q=subprocess.run(args,capture_output=True,text=True,cwd='/private/tmp')
 assert q.returncode==0,q.stderr
 result=json.loads(q.stdout)
 assert result['modulePath']==str(Path('scripts/qa09_log_read.py').resolve())
 assert result['readerSha256']==h(Path('scripts/qa09_log_read.py'))
 tests.append({'path':row['path'],'args':args,'exit':q.returncode,'result':result})
bindings={row['path']:row['sha256'] for row in derived}
for n in ['r0/collect-initial.closure.exit','r0/collect-initial.closure.stderr.log','r0/finish-unit.pipeline.exit','r0/finish-unit.pipeline.stderr.log','preflight/entry-scope.json']:
 bindings[n]=h(root/n)
out.write_text(json.dumps({'gate':'PASS','scope':'LOCAL_IMPORT_BEFORE_ANY_AUXILIARY_LOG_READ_ONLY','sourceCommit':sha,'originalFailurePreserved':True,'businessReplays':0,'newDeployments':0,'newBuilds':0,'originalInitialReadStarted':False,'derived':derived,'directIsolatedEntryTests':tests,'bindings':bindings},indent=2)+'\n')
print(json.dumps({'gate':'PASS','derivedHelpers':len(derived),'isolatedEntryTests':len(tests),'newAwsCalls':0}))
