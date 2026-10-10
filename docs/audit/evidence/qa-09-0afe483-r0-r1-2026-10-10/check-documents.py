"""Validate final local documentation against completed receipts; no network or AWS."""
from pathlib import Path
import hashlib, json, re

root = Path(__file__).resolve().parent
repo = root.parents[3]
out = root / 'document-check.json'
assert not out.exists()
comparison = json.loads((root / 'comparison.json').read_text())
restore = json.loads((root / 'restore/restore-completion.json').read_text())
assert comparison['gate'] == 'PARTIAL' and comparison['restoreGate'] == restore['gate'] == 'PASS'
assert comparison['fullQa09Accepted'] is False and comparison['p95Accepted'] is False
assert json.loads((root / 'final-checks/summary.json').read_text())['gate'] == 'PASS'
report = repo / 'docs/audit/QA-09-0afe483启动前只读恢复R0-R1目标复验-2026-10-10.md'
task = repo / 'docs/管理后台开发任务清单.md'
readme = root / 'README.md'
bindings, links = {}, []
for p in [report, task, readme]:
    b = p.read_bytes(); text = b.decode(); bindings[str(p.relative_to(repo))] = hashlib.sha256(b).hexdigest()
    assert '0afe483' in text
    if p != task:
        assert comparison['sourceCommit'] in text and str(restore['runId']) in text
        assert '执行中' not in text and 'IN PROGRESS' not in text
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', text):
            if re.match(r'^(?:https?://|#)', target): continue
            path = target.strip('<>').split('#', 1)[0]
            resolved = (p.parent / path).resolve()
            assert resolved.is_relative_to(repo) and resolved.exists(), 'LOCAL_LINK_MISSING:' + target
            links.append(dict(document=str(p.relative_to(repo)), target=target))
assert report.name in task.read_text().split('\n\n')[-2], 'LATEST_TASK_ENTRY_REQUIRED'
v = dict(gate='PASS', scope='FINAL_REPORT_TASK_ENTRY_LOCAL_LINKS_AND_DOCUMENT_BYTES_ONLY', sourceCommit=comparison['sourceCommit'], restoreRunId=restore['runId'], documentBindings=bindings, localLinksVerified=links, fullQa09Accepted=False, p95Accepted=False)
out.write_text(json.dumps(v, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(dict(gate='PASS', documents=len(bindings), localLinks=len(links))))
