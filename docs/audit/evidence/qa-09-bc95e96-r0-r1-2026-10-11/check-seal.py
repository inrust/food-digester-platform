"""Recheck sealed evidence and source bytes without creating receipts or target work."""
from pathlib import Path
import hashlib, json, subprocess

root = Path(__file__).resolve().parent
repo = root.parents[3]
v = json.loads((root / 'manifest.json').read_text())
assert v['gate'] == 'PARTIAL' and v['seal'] == 'PASS'
assert v['p95Accepted'] is False and v['fullQa09Accepted'] is False
actual = {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}
assert actual == set(v['files']) | {'manifest.json'}, 'UNBOUND_FILE_OR_MISSING_FILE'
for name, h in v['files'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == h, name
for name, h in v['documentBindings'].items():
    assert hashlib.sha256((repo / name).read_bytes()).hexdigest() == h, name
completion = json.loads((root / 'completion.json').read_text())
assert completion['gate'] == 'PASS' and completion['qa09Gate'] == 'PARTIAL'
for name, h in completion['bindings'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == h, name
assert not subprocess.check_output(['git', 'diff', v['sourceCommit'], '--', 'apps', 'packages', 'contracts', 'infra', 'scripts', '.github', 'package.json', 'pnpm-lock.yaml'], cwd=repo)
subprocess.run(['git', 'diff', '--check'], cwd=repo, check=True)
print(json.dumps(dict(gate='PASS', sealedFiles=len(v['files']), documents=len(v['documentBindings']),
                      applicationSourceUnchanged=True, qa09Gate='PARTIAL', p95Accepted=False)))
