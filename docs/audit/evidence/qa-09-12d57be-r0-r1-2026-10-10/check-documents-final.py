"""Check final local prose and links against immutable target receipts; no network."""
from pathlib import Path
import hashlib, json, re

root = Path(__file__).resolve().parent
repo = root.parents[3]
out = root / 'document-check.json'
assert not out.exists()
comparison = json.loads((root / 'comparison.json').read_text())
restore = json.loads((root / 'restore/restore-completion.json').read_text())
assert comparison['gate'] == 'PARTIAL'
assert comparison['restoreGate'] == restore['gate'] == 'PASS'
assert comparison['fullQa09Accepted'] is False and comparison['p95Accepted'] is False
assert json.loads((root / 'final-checks/summary.json').read_text())['gate'] == 'PASS'
assert json.loads((root / 'additional-proofs.json').read_text())['gate'] == 'PASS'
report = repo / 'docs/audit/QA-09-12d57be合同公开接缝R0-R1目标复验-2026-10-10.md'
task = repo / 'docs/管理后台开发任务清单.md'
bindings, links = {}, []
for p in [report, task, root / 'README.md']:
    b = p.read_bytes()
    text = b.decode()
    bindings[str(p.relative_to(repo))] = hashlib.sha256(b).hexdigest()
    assert '12d57be' in text
    if p == task:
        continue
    assert comparison['sourceCommit'] in text and str(restore['runId']) in text
    assert '执行中' not in text and 'IN PROGRESS' not in text
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', text):
        if re.match(r'^(?:https?://|#)', target):
            continue
        resolved = (p.parent / target.strip('<>').split('#', 1)[0]).resolve()
        assert resolved.is_relative_to(repo) and resolved.exists(), target
        links.append(dict(document=str(p.relative_to(repo)), target=target))
assert report.name in [v for v in task.read_text().split('\n\n') if v.strip()][-1]
v = dict(gate='PASS', scope='FINAL_DOCUMENT_BYTES_AND_LOCAL_LINKS_ONLY',
         sourceCommit=comparison['sourceCommit'], restoreRunId=restore['runId'],
         documentBindings=bindings, localLinksVerified=links,
         p95Accepted=False, fullQa09Accepted=False)
out.write_text(json.dumps(v, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(dict(gate='PASS', documents=len(bindings), localLinks=len(links))))
