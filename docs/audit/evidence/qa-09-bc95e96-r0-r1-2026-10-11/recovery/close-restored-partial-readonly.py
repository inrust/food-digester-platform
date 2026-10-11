"""Preserve failed final capacity start while closing the independent final empty audit."""
from pathlib import Path
import datetime,hashlib,json
root=Path(__file__).resolve().parent.parent;p=root/'restore';out=p/'post-restoration-readonly.json';assert not out.exists()
def read(n):return json.loads((root/n).read_text())
restored=read('restore/restore-completion.json');cap=read('restore/capacity-before.json');empty=read('restore/database-empty-audit.json');diag=read('recovery/unknown-restored-capacity-diagnostic.json');trail=read('recovery/unknown-restored-capacity-cloudtrail.json')
assert restored['gate']=='PASS' and 'R0_FAILED_STAGE' in restored['scope']
assert cap['gate']=='FAIL' and cap['failure']['kind']=='START_OUTCOME_UNCONFIRMED' and not cap.get('build')
assert (diag.get('windowCovered') and diag['exactPlanMatches']==0) or (diag['gate']=='UNAVAILABLE' and diag['writes']==0 and diag['exactPlanMatches'] is None)
assert trail['gate']=='NOT_OBSERVED' and trail['absenceProvesNonExecution'] is False
assert empty['gate']=='PASS' and empty['build']['status']=='SUCCEEDED' and empty['result']['action']=='audit-empty'
assert read('restore/audit-empty-prestart-gate.json')['gate']=='PASS'
assert not (p/'capacity-before-gate.json').exists() and not (p/'prestart-entry-gate.json').exists()
names=['restore-completion.json','actual-config.json','capacity-before.json','database-empty-audit.json','audit-empty-prestart-gate.json','independent-final-empty-entry.json']
result=dict(gate='PARTIAL',scope='RESTORED_DEFAULT_OFF_FINAL_EMPTY_PASS_FINAL_CAPACITY_START_UNKNOWN',sourceCommit=restored['sourceCommit'],runId=restored['runId'],finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),defaultOffRestoreGate='PASS',finalEmptyGate='PASS',finalCapacityGate='UNKNOWN',originalCapacityExecutionGate='FAIL',capacityRestarts=0,newBusinessFixtures=0,newBusinessRequests=0,budgetScope='STATIC_AND_R0_SAMPLED_CONNECTIONS_ONLY_NO_FRESH_FINAL_CAPACITY_SNAPSHOT',bindings={n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in names},diagnosticBindings={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in ['recovery/unknown-restored-capacity-diagnostic.json','recovery/unknown-restored-capacity-cloudtrail.json']},p95Accepted=False,fullQa09Accepted=False)
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['bindings','diagnosticBindings']}))
