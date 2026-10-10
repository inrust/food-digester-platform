"""Compare already captured same-SHA artifacts/configs; no network or mutation."""
from pathlib import Path
import datetime, hashlib, json, sys

root = Path(__file__).resolve().parent
mode = sys.argv[1]
prior = {'r0': 'default-off', 'r1': 'r0', 'restore': 'r1'}[mode]
sha = '12d57befe55be1e1abfd1e226c2d13cbace992dc'
out = root / mode / 'artifact-transition.json'
assert not out.exists()
bindings = {}
def read(name):
    data = (root / name).read_bytes()
    bindings[name] = hashlib.sha256(data).hexdigest()
    return json.loads(data)
before, after = [read(m + '/application-version.json') for m in [prior, mode]]
for v in [before, after]:
    assert v['gate'] == 'PASS' and v['sourceCommit'] == sha and len(v['lambdaArtifacts']) == 19
old = {v['name']: v for v in before['lambdaArtifacts']}
new = {v['name']: v for v in after['lambdaArtifacts']}
assert set(old) == set(new) and len(old) == 19
for name, v in new.items():
    assert all(v[k] == old[name][k] for k in ['codeSha256', 'artifactSha256', 's3Bucket', 's3Key', 'runtime'])
    if name != 'fdp-test-api':
        assert v['revisionId'] == old[name]['revisionId'], 'NON_API_REVISION_DRIFT:' + name
config = read(mode + '/actual-config.json')
assert config['gate'] == 'PASS' and config['sourceCommit'] == sha
assert config['config']['revisionId'] == new['fdp-test-api']['revisionId']
for key in ['preconnect', 'contractLoadDetail', 'contractPublicBoundaries']:
    assert config['config'][key] == str(mode != 'restore').lower()
assert config['config']['accountReadCandidate'] == str(mode == 'r1').lower()
result = {'gate': 'PASS', 'scope': 'CAPTURED_19_CODE_BYTES_AND_NON_API_REVISION_TRANSITION_ONLY',
          'sourceCommit': sha, 'priorMode': prior, 'mode': mode, 'artifactCount': 19,
          'allCodeUnchanged': True, 'nonApiRevisionsUnchanged': True,
          'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'bindings': bindings, 'newRequests': 0, 'p95Accepted': False, 'fullQa09Accepted': False}
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'bindings'}))
