"""Local evidence syntax, credential hygiene and immutable receipt checks; no AWS writes."""
import ast, base64, hashlib, json, re, subprocess
from pathlib import Path

root = Path(__file__).parent
out = root / 'final-checks'
out.mkdir(exist_ok=True)
assert not (out / 'summary.json').exists(), 'NO_CHECK_OVERWRITE'
files = sorted(p for p in root.rglob('*') if p.is_file())
patterns = [re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),
            re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),
            re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
python_count = node_count = decoded_count = 0
for p in files:
    data = p.read_bytes()
    assert not any(x.search(data) for x in patterns), 'SECRET_PATTERN:' + str(p)
    if p.suffix == '.py':
        ast.parse(data, filename=str(p))
        python_count += 1
    elif p.suffix == '.mjs':
        q = subprocess.run(['node', '--check', str(p)], capture_output=True)
        assert q.returncode == 0, 'NODE_SYNTAX:' + str(p)
        node_count += 1
    if p.suffix == '.json':
        value = json.loads(data)
        def walk(v):
            global decoded_count
            if isinstance(v, dict):
                for key, item in v.items():
                    if key == 'source' and isinstance(item, dict) and item.get('type') == 'NO_SOURCE':
                        spec = item.get('buildspec', '')
                        for token in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}', spec):
                            try:
                                decoded = base64.b64decode(token, validate=True)
                            except ValueError:
                                continue
                            assert not any(x.search(decoded) for x in patterns), 'DECODED_SECRET:' + str(p)
                            decoded_count += 1
                    walk(item)
            elif isinstance(v, list):
                for item in v:
                    walk(item)
        walk(value)
for mode, name in [('r0', 'unit-completion.json'), ('r1', 'unit-completion.json'),
                   ('restore', 'restore-completion.json'), ('restore', 'post-restoration-readonly.json')]:
    receipt = json.loads((root / mode / name).read_text())
    assert receipt['gate'] == 'PASS'
    for name, digest in receipt['bindings'].items():
        assert hashlib.sha256((root / mode / name).read_bytes()).hexdigest() == digest, 'BOUND_BYTES_DRIFT'
sha = '88d9f0a5a734aacf0aef6af69c5a4985baacfe84'
q = subprocess.run(['git', 'diff', sha, '--', 'apps', 'packages', 'contracts', 'infra',
                    'scripts', '.github', 'package.json', 'pnpm-lock.yaml'], capture_output=True)
assert q.returncode == 0 and not q.stdout, 'APPLICATION_SOURCE_DRIFT'
q = subprocess.run(['git', 'diff', '--check'], capture_output=True)
assert q.returncode == 0, 'DIFF_CHECK'
result = {'gate': 'PASS', 'scope': 'LOCAL_EVIDENCE_SYNTAX_HYGIENE_BINDINGS_ONLY',
          'sourceCommit': sha, 'filesScanned': len(files), 'pythonAst': python_count,
          'nodeSyntax': node_count, 'decodedSourcesScanned': decoded_count,
          'secretPatternHits': 0, 'applicationSourceUnchanged': True,
          'receiptBindings': 'PASS', 'gitDiffCheck': 'PASS', 'fullQa09Accepted': False}
(out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
