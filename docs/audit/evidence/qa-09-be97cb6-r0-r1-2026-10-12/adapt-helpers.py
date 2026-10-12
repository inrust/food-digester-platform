"""Close new collector dependency, serial-budget and immutable recovery bindings."""
from pathlib import Path
root=Path(__file__).resolve().parent
for mode in ['r0','r1']:
 p=root/mode/'verify-target.mjs';s=p.read_text()
 s="import { checkLogReadBudget } from '../../../../../scripts/check-qa09-log-read-budget.mjs';\n"+s
 marker="const child = read('sample.json'),"
 guard='''const verifyReadBudget = (receipt, name) => {
  const originalName = name.replace('.json', '-original.json');
  read(originalName);
  if (!receipt.readOptimization) demand(bindings[name] === bindings[originalName], 'ORIGINAL_READ_BYTES_REQUIRED');
  const proof = checkLogReadBudget(receipt, {
    sourceSha256: bindings['sample.json'],
    collectorSha256: digest(readFileSync('scripts/collect-qa09-contract-correlation.py')),
    readerSha256: digest(readFileSync('scripts/qa09_log_read.py')),
    projectorSha256: digest(readFileSync('scripts/qa09_observer_cost.py')),
    ...(receipt.readOptimization ? {priorSha256: bindings[originalName]} : {}),
  });
  demand(proof.gate === 'PASS', 'BOUNDED_READ_PROOF_REQUIRED');
};
'''
 s=s.replace(marker,guard+marker)
 s=s.replace("for (const [r, n] of [", "verifyReadBudget(patch, 'baseline-patch.json');\nverifyReadBudget(audit, 'baseline-audit.json');\nfor (const [r, n] of [",1)
 s=s.replace("const sample = validateSamplingCorrelationLedger", "verifyReadBudget(samplePatch, 'sampling-patch.json');\nverifyReadBudget(sampleAudit, 'sampling-audit.json');\nconst sample = validateSamplingCorrelationLedger")
 p.write_text(s)
 for name,out in [('collect-initial-phases.py','initial-phases.json'),('collect-negative-phases.py','negative-phases.json')]:
  p=root/mode/name;s=p.read_text().replace("print(json.dumps({'gate':'PASS','requests':len(records)}))", "print(json.dumps({'gate':result['gate'],'requests':len(records)}))")
  s=s.replace("root = Path(__file__).parent", "root = Path(__file__).parent\nassert not (root/'"+out+"').exists(), 'PRESERVE_ORIGINAL_AUXILIARY_OUTPUT'")
  p.write_text(s)
p=root/'complete-unit.py';s=p.read_text();pos="peak=read('connection-budget-gate.json')"
proof='''for group in ['baseline-patch','baseline-audit','sampling-patch','sampling-audit']:
 proof=read(group+'-budget.stdout.log')
 assert proof['gate']=='PASS' and proof['scope']=='BOUNDED_READ_RECEIPT_AND_SOURCE_BYTES'
 assert (p/(group+'-budget.exit')).read_text().strip()=='0'
 read(group+'-original.json')
for name in ['initial-phases.json','negative-phases.json']:
 aux=read(name);budget=aux['logReadBudget']
 assert aux['gate']=='PASS' and not aux['logReadErrors'] and budget['error'] is None
 assert budget['totalDeadlineMs']==120000 and budget['callTimeoutMs']==15000 and len(budget['attempts'])<=40
 assert all(a['result']=='PASS' for a in budget['attempts'])
 assert aux['readerSha256']==hashlib.sha256(Path('scripts/qa09_log_read.py').read_bytes()).hexdigest()
'''
s=s.replace(pos,proof+'\n'+pos);s=s.replace("'cleanup':'PASS','originalExecutionGate'", "'logReadBudgetGate':'PASS','exactInvocationBatchSize':3,'cleanup':'PASS','originalExecutionGate'");p.write_text(s)
for name in ['final-checks.py','validate-current-pair.py']:
 p=root/name;s=p.read_text().replace("ci['attempt'] == 1", "ci['attempt'] == 2")
 s=s.replace("['node','scripts/check-qa09-owned-summary.mjs','docs/audit/evidence/qa-09-owned-summary-2026-10-11']", "['python3',str(root/'check-implementation-seal.py')]")
 s=s.replace("== 'LOCAL_OWNED_SUMMARY_PASS'", "== 'LOCAL_LOG_READ_BUDGET_PASS'").replace('implementation_count = 227','implementation_count = 160').replace("get('sealedFiles',227)","get('sealedFiles',160)")
 p.write_text(s)
p=root/'check-artifact-transition.py';s=p.read_text().replace("str(mode == 'r1').lower()", "str(mode in ['r0','r1']).lower()");p.write_text(s)
