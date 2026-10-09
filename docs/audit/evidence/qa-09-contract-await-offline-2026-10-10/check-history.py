import ast
import hashlib
import json
from pathlib import Path

rows = []
for name, expected in [('qa-09-24d50d6-r0-r1-2026-10-09', 752), ('qa-09-f7abb06-r0-r1-2026-10-09', 404)]:
    root = Path('docs/audit/evidence') / name
    manifest = root / 'manifest.json'
    raw = manifest.read_bytes()
    data = json.loads(raw)
    assert len(data['files']) == expected
    for relative, digest in data['files'].items():
        target = (root / relative).resolve()
        assert target.is_relative_to(root.resolve())
        assert hashlib.sha256(target.read_bytes()).hexdigest() == digest, relative
    rows.append({'manifest': str(manifest), 'manifestSha256': hashlib.sha256(raw).hexdigest(), 'filesVerified': expected, 'gate': 'PASS', 'oldGatePreserved': data['gate']})
ast.parse(Path('scripts/collect-qa09-contract-correlation.py').read_text())
result = {'gate': 'PASS', 'scope': 'IMMUTABLE_PRIOR_RECEIPTS_AND_COLLECTOR_SYNTAX_ONLY', 'rows': rows, 'collectorSyntax': 'PASS'}
Path('docs/audit/evidence/qa-09-contract-await-offline-2026-10-10/history-integrity.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'gate': 'PASS', 'historicalFilesVerified': sum(r['filesVerified'] for r in rows)}))
