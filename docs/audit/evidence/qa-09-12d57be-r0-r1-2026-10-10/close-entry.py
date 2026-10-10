"""Bind already-observed entry proofs; local only, no AWS mutation."""
from pathlib import Path
import json, hashlib, datetime, subprocess
root = Path(__file__).resolve().parent
sha = '12d57befe55be1e1abfd1e226c2d13cbace992dc'
out = root / 'preflight/entry-completion.json'
assert not out.exists()
assert subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip() == sha
bindings = {}
def read(name):
    data = (root / name).read_bytes()
    bindings[name] = hashlib.sha256(data).hexdigest()
    return json.loads(data)
ci = read('preflight/ci-run.json')
assert ci['headSha'] == sha and ci['status'] == 'completed' and ci['conclusion'] == 'success'
for name in ['default-off/deployment-input-binding.json', 'default-off/application-version.json', 'default-off/actual-config.json', 'default-off/hosted-verify-38048245357.json']:
    item = read(name)
    assert item['gate'] == 'PASS' and item['sourceCommit'] == sha
assert len(read('default-off/application-version.json')['lambdaArtifacts']) == 19
assert read('preflight/capacity-before-gate.json')['gate'] == 'PASS'
entry = read('preflight/prestart-entry-gate.json')
assert entry['gate'] == 'PASS' and entry['sourceCommit'] == sha
for name, expected in entry['bindings'].items():
    assert hashlib.sha256((root / 'preflight' / name).read_bytes()).hexdigest() == expected
session = read('preflight/renewable-session-gate.json')
assert session['gate'] == 'PASS'
history = read('preflight/history-binding.json'); assert history['gate'] == 'PASS'
plan = read('preflight/planned-inputs.json')
assert plan['r0']['sourceCommit'] == plan['r1']['sourceCommit'] == sha
local = root.parent / 'qa-09-contract-public-runtime-2026-10-10/manifest.json'
implementation = json.loads(local.read_text())
assert implementation['gate'] == 'PASS' and implementation['scope'] == 'LOCAL_NO_FORCED_YIELD_PUBLIC_SEAMS_AND_DEFAULT_OFF_WIRING_ONLY'
for name, expected in implementation['sourceBindings'].items():
    assert hashlib.sha256(subprocess.check_output(['git', 'show', sha + ':' + name])).hexdigest() == expected
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected
helpers = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.suffix in ['.py', '.mjs']}
(root / 'preflight/entry-scope.json').write_text(json.dumps({'gate': 'PASS', 'sourceCommit': sha, 'entryHelpers': helpers, 'implementationManifestSha256': hashlib.sha256(local.read_bytes()).hexdigest(), 'originalUnknownNotReplayed': True}, indent=2) + '\n')
read('preflight/entry-scope.json')
out.write_text(json.dumps({'gate': 'PASS', 'scope': 'SAME_SHA_DEFAULT_OFF_19_ARTIFACTS_RENEWABLE_SESSION_CAPACITY_AND_NEW_PRESTART_PROOF_ONLY', 'sourceCommit': sha, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'bindings': bindings, 'p95Accepted': False, 'fullQa09Accepted': False}, indent=2) + '\n')
print('entry PASS; no business fixtures yet')
