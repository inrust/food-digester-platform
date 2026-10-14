"""Verify task-state synchronization and sealed acceptance without cloud business requests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
BASE = 'a58714d4b6c3d225131f9d1c311e76c84b3d3afb'
sha = lambda b: hashlib.sha256(b).hexdigest()
read = lambda name: (REPO / name).read_bytes()
summary_path = 'docs/audit/evidence/qa09-minimum-accepted-2026-10-14/a8-summary.json'
summary = json.loads(read(summary_path))
assert summary['gate'] == 'PASS_MINIMUM_QA09_ONLY' and summary['minimumPhaseAccepted'] is True
assert (summary['retainedRequirementCount'], summary['deferredRequirementCount'], summary['minimumFormalPassCount']) == (14, 10, 8)
for key in ['fullQa09Accepted', 'releasePerformanceAccepted', 'productionReady']:
    assert summary[key] is False, key

sealed_path = 'docs/audit/evidence/qa09-minimum-accepted-2026-10-14/manifest.json'
sealed = json.loads(read(sealed_path))
assert read(sealed_path) == subprocess.check_output(['git', 'show', f'{BASE}:{sealed_path}'], cwd=REPO)
intentional_rebinding = []
for row in sealed['files']:
    historical = subprocess.check_output(['git', 'show', f"{BASE}:{row['file']}"], cwd=REPO)
    assert sha(historical) == row['sha256'], row['file']
    if sha(read(row['file'])) != row['sha256']:
        assert row['file'] == 'scripts/qa09-acceptance-entry.test.mjs', row['file']
        intentional_rebinding.append(row['file'])
assert read(summary_path) == subprocess.check_output(['git', 'show', f'{BASE}:{summary_path}'], cwd=REPO)

paths = ['docs/管理后台开发任务清单.md', 'docs/dev/QA-09-业务闭环优先收口计划.md', 'docs/AWS云端运维任务清单.md']
release_ids = ['REL-MATERIAL-CLAIMS-01', 'REL-MATERIAL-NOTIFY-01', 'REL-MATERIAL-SETTING-01', 'REL-A2-01', 'REL-QUEUE-01', 'REL-PERF-01']
for path in paths:
    text = read(path).decode()
    assert ('最小范围验收完成' in text or '最小范围验收已完成' in text or '最小范围已通过' in text), path
    assert all(token in text for token in ['fullQa09Accepted=false', 'releasePerformanceAccepted=false', 'productionReady=false']), path
    for link in re.findall(r'\]\(([^)]+)\)', text):
        if not link.startswith(('https:', 'http:', '#')):
            assert (REPO / path).parent.joinpath(link.split('#')[0]).resolve().exists(), (path, link)

tasks = read(paths[0]).decode()
active_tasks = re.sub(r'<details>.*?</details>', '', tasks, flags=re.S)
active_plan = read(paths[1]).decode()
for text in [active_tasks, active_plan]:
    for token in release_ids:
        assert re.search(r'^- \[ \].*' + re.escape(token), text, re.M), token
    assert '本次最小范围无活动待办' in text
    assert '下一可执行任务：继续QA09-CLOSE-07' not in text
assert active_tasks.count('- [x] A') == 6
assert [f'QA09-CLOSE-{i:02d}' for i in range(1, 9)] == re.findall(r'^\| (QA09-CLOSE-\d\d)', active_plan, re.M)

# Historical execution paragraphs remain byte-for-byte lines in collapsed sections.
old = subprocess.check_output(['git', 'show', f'{BASE}:{paths[0]}'], cwd=REPO).decode()
history = [line for line in old.splitlines() if line.startswith('2026-10-') or line.startswith('**QA09-CLOSE-01（') or re.match(r'^- \*\*.*（2026-10-\d\d）', line)]
assert len(history) > 40
assert all(line in tasks for line in history), 'HISTORICAL_EXECUTION_PARAGRAPH_CHANGED'
ops = read(paths[2]).decode()
assert 'SES/Webhook 业务通知延期，不作为当前上线验收项' not in ops
for token in release_ids[:4]:
    assert re.search(r'^- \[ \].*' + token, ops, re.M), token
result = {
    'gate': 'PASS_TASK_STATE_SYNC_AND_SEALED_MINIMUM_ACCEPTANCE',
    'sourceAcceptanceCommit': BASE, 'sourceSummary': {'file': summary_path, 'sha256': sha(read(summary_path))},
    'minimumPhaseAccepted': True, 'minimumOutstanding': [], 'retainedRequirementsPassed': 14,
    'explicitlyDeferredRequirements': 10, 'minimumFormalDomainsPassed': 8,
    'fullQa09Accepted': False, 'releasePerformanceAccepted': False, 'productionReady': False,
    'releaseRequirementIds': release_ids, 'historicalParagraphsPreserved': len(history),
    'sealedMinimumManifestUnchanged': True, 'sealedSourceBytesVerifiedAtAcceptanceCommit': True,
    'intentionalCurrentTestFixtureRebinding': intentional_rebinding, 'newCloudBusinessTests': 0,
    'documents': [{'file': path, 'sha256': sha(read(path))} for path in paths],
}
(HERE / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'gate': result['gate'], 'historicalParagraphsPreserved': len(history), 'minimumOutstanding': []}))
