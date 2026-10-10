"""Local bindings for the exact read continuation and all captured artifact transitions."""
from pathlib import Path
import hashlib, json

root = Path(__file__).resolve().parent
bindings = {}
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def read(name):
    p = root / name
    bindings[name] = digest(p)
    return json.loads(p.read_text())
provenance = read('continuation-helper-provenance.json')
assert digest(root / provenance['originalHelper']) == provenance['originalSha256']
assert digest(root / provenance['continuationHelper']) == provenance['continuationSha256']
entry = read('r0/wait-read-recovery.json')
assert entry['gate'] == 'READY' and entry['originalReadGate'] == 'FAIL' and entry['newDispatches'] == 0
assert entry['businessStarted'] is False and entry['maximumNewWaits'] == 1
for name, expected in entry['bindings'].items():
    assert digest(root / 'r0' / name) == expected
assert int((root / 'r0/wait-success.pipeline.exit').read_text()) != 0
assert int((root / 'r0/wait-success-recovery.pipeline.exit').read_text()) == 0
assert read('r0/unit-completion.json')['originalExecutionGate'] == 'PASS'
transitions = []
for mode in ['r0', 'r1', 'restore']:
    v = read(mode + '/artifact-transition.json')
    assert v['gate'] == 'PASS' and v['artifactCount'] == 19
    assert v['allCodeUnchanged'] is True and v['nonApiRevisionsUnchanged'] is True
    for name, expected in v['bindings'].items():
        assert digest(root / name) == expected
    transitions.append(mode)
result = {'gate': 'PASS', 'scope': 'LOCAL_EXACT_READ_CONTINUATION_AND_CAPTURED_ARTIFACT_TRANSITION_BINDINGS_ONLY',
          'sourceCommit': entry['sourceCommit'], 'originalWaitReadGate': 'FAIL', 'effectiveWaitReadGate': 'PASS',
          'newDispatchesOnReadRecovery': 0, 'businessReplays': 0, 'artifactTransitions': transitions,
          'bindings': bindings, 'p95Accepted': False, 'fullQa09Accepted': False}
out = root / 'additional-proofs.json'
assert not out.exists()
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'bindings'}))
