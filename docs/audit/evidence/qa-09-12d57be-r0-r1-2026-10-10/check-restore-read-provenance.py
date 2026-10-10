"""Check one exact restore workflow read continuation; no target operations."""
from pathlib import Path
import hashlib, json

root = Path(__file__).resolve().parent
p = root / 'restore'
out = root / 'restore-read-provenance.json'
assert not out.exists()
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
v = json.loads((root / 'restore-continuation-helper-provenance.json').read_text())
assert digest(root / v['originalHelper']) == v['originalSha256']
assert digest(root / v['continuationHelper']) == v['continuationSha256']
entry = json.loads((p / 'wait-read-recovery.json').read_text())
assert entry['gate'] == 'READY' and entry['originalReadGate'] == 'FAIL'
assert entry['maximumNewWaits'] == 1 and entry['newDispatches'] == entry['newBusinessFixtures'] == 0
for name, h in entry['bindings'].items():
    assert digest(p / name) == h
assert (p / 'wait-success.pipeline.exit').read_text().strip() != '0'
assert (p / 'wait-success-recovery.pipeline.exit').read_text().strip() == '0'
restore = json.loads((p / 'restore-completion.json').read_text())
assert restore['gate'] == 'PASS' and restore['sourceCommit'] == entry['sourceCommit']
assert str(restore['runId']) == str(entry['runId']) and restore['newFixtures'] == 0
names = ['restore-continuation-helper-provenance.json', 'restore/wait-read-recovery.json',
         'restore/wait-success.pipeline.exit', 'restore/wait-success.pipeline.stderr.log',
         'restore/wait-success-recovery.pipeline.exit', 'restore/restore-completion.json']
result = dict(gate='PASS', scope='EXACT_EXISTING_RESTORE_READ_CONTINUATION_AND_ORIGINAL_FAILURE_BINDINGS_ONLY',
    sourceCommit=entry['sourceCommit'], runId=entry['runId'], originalReadGate='FAIL',
    effectiveReadGate='PASS', newDispatches=0, newBusinessFixtures=0,
    bindings={n:digest(root / n) for n in names}, p95Accepted=False, fullQa09Accepted=False)
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k:v for k,v in result.items() if k != 'bindings'}))
