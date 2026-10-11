"""Run the still-unstarted planned final empty audit after an unknown readonly capacity start."""
from pathlib import Path
import datetime,hashlib,json,subprocess
root=Path(__file__).resolve().parent.parent;p=root/'restore'
def read(n):return json.loads((root/n).read_text())
restore=read('restore/restore-completion.json');cap=read('restore/capacity-before.json')
assert restore['gate']=='PASS' and 'R0_FAILED_STAGE' in restore['scope']
assert cap['gate']=='FAIL' and cap['failure']['kind']=='START_OUTCOME_UNCONFIRMED' and not cap.get('build')
assert (p/'capacity.readonly.exit').read_text().strip()=='1'
assert read('r0/cleanup-only-completion.json')['cleanup']=='PASS'
for n,h in restore['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
assert not (p/'database-empty-audit.json').exists() and not (p/'audit-empty.readonly.exit').exists()
args=['node',str(p/'audit-empty.mjs')]
(p/'audit-empty.readonly.command.json').write_text(json.dumps(args)+'\n')
entry=dict(scope='CONTINUE_ONLY_UNSTARTED_PLANNED_FINAL_AUDIT_EMPTY_AFTER_UNKNOWN_READONLY_CAPACITY',restoreGate='PASS',capacityOriginalGate='UNKNOWN',newCapacityStarts=0,businessWrites=0,originalFinishGate='FAIL',startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),bindings={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ['restore/restore-completion.json','restore/capacity-before.json','restore/capacity.readonly.exit','r0/cleanup-only-completion.json','restore/audit-empty.mjs']})
(p/'independent-final-empty-entry.json').write_text(json.dumps(entry,indent=2)+'\n')
with (p/'audit-empty.readonly.stdout.log').open('w') as o,(p/'audit-empty.readonly.stderr.log').open('w') as e:q=subprocess.run(args,stdout=o,stderr=e)
(p/'audit-empty.readonly.exit').write_text(str(q.returncode)+'\n')
print(json.dumps(dict(step='original_planned_final_empty_audit',exit=q.returncode)),flush=True)
assert q.returncode==0
