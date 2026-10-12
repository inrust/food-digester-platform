"""Validate the plan and historical bytes locally; this is no cloud acceptance."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
read = lambda name: (REPO / name).read_bytes()
sha = lambda raw: hashlib.sha256(raw).hexdigest()
plan = json.loads((ROOT / 'inventory.json').read_bytes())
assert plan['scope'] == 'EXECUTION_PLAN_AND_HISTORICAL_INVENTORY_ONLY'
assert plan['qa09Gate'] == 'PARTIAL'
for key in ['fullQa09Accepted', 'releasePerformanceAccepted', 'productionReady']:
    assert plan[key] is False, key
assert plan['newCloudRuns'] == 0 and plan['newFunctionalWaivers'] == []
assert plan['performanceStatus'] == 'DEFERRED_TO_RELEASE_NOT_ACCEPTED'
assert plan['nextExecutableTask'] == 'QA09-CLOSE-01'
assert [x['id'] for x in plan['workPackages']] == [f'QA09-CLOSE-{n:02d}' for n in range(1, 9)]
assert not any(x['status'] == 'PASS' for x in plan['workPackages'])
for name, wanted in plan['sources'].items():
    assert sha(read(name)) == wanted, name
legal = json.loads(read(next(p for p in plan['sources'] if p.endswith('legal-coverage.json'))))
history = plan['historicalOnly']
assert history['missingCandidatePairs'] == legal['missingPairs']
assert (history['interfaces'], history['permittedPairs']) == (43, 75)
assert len(legal['missingPairs']) == 37
assert 75 + 37 == history['candidatePairs'] == 112
assert sum(x['reason'].startswith('DOMAIN_RETIREMENT_') for x in legal['missingPairs']) == 1
semantic_name = next(p for p in plan['sources'] if '117项语义矩阵' in p)
semantic = read(semantic_name).decode()
rows = re.findall(r'^\| [^|]+ \| (?:Adopt|Adapt) \| (PASS|NOT_RUN) \|', semantic, re.M)
assert (rows.count('PASS'), rows.count('NOT_RUN'), len(rows)) == (100, 17, 117)
assert history['countsAreNotCurrentAcceptance'] is True

# Deliberately check the historical document at its recorded commit.
# The current task list has an authorized new schedule; never rewrite the old seal.
seal_path = 'docs/audit/evidence/qa-09-ad213fa-r0-r1-2026-10-12'
seal_root = REPO / seal_path
seal = json.loads((seal_root / 'manifest.json').read_bytes())
actual = {str(p.relative_to(seal_root)): sha(p.read_bytes())
          for p in seal_root.rglob('*') if p.is_file() and p.name != 'manifest.json'}
assert actual == seal['files']
for name, wanted in seal['bindings'].items():
    raw = subprocess.check_output(['git', 'show', f"{plan['historicalSealBindingCommit']}:{name}"], cwd=REPO)
    assert sha(raw) == wanted, name
assert (len(actual), len(seal['bindings'])) == (792, 24)
assert seal['fullQa09Accepted'] is False and seal['p95Accepted'] is False
for mode in ['r0', 'r1']:
    unit = json.loads((seal_root / mode / 'unit-completion.json').read_bytes())
    assert unit['gate'] == unit['originalExecutionGate'] == 'PASS'
    assert unit['cleanup'] == unit['independentEmptyAudit'] == 'PASS'
assert json.loads((seal_root / 'restore/post-restoration-readonly.json').read_bytes())['gate'] == 'PASS'

handbook_name = 'docs/dev/QA-09-业务闭环优先收口计划.md'
handbook = read(handbook_name).decode()
tasks = read('docs/管理后台开发任务清单.md').decode()
for token in ['QA09-CLOSE-01', 'QA09-CLOSE-08', 'REL-PERF-01', 'productionReady=false']:
    assert token in handbook and token in tasks, token
assert '不再默认进入性能R0/R1' in handbook
assert '真实邀请发送继续NOT_RUN' in handbook
assert '当前排程（2026-10-12，用户确认）' in tasks
links = re.findall(r'\]\(([^)]+)\)', handbook)
for link in links:
    assert (REPO / handbook_name).parent.joinpath(link).resolve().exists(), link
result = {
    'gate': 'PASS', 'scope': 'LOCAL_PLAN_AND_HISTORICAL_BYTES_ONLY',
    'sources': len(plan['sources']), 'historicalEvidenceFiles': len(actual),
    'historicalCommittedBindings': len(seal['bindings']), 'localLinks': len(links),
    'historicalSemanticCounts': {'pass': 100, 'notRun': 17},
    'historicalLegalCandidateCounts': {'observed': 75, 'missing': 37},
    'qa09Gate': 'PARTIAL', 'newCloudRuns': 0,
    'fullQa09Accepted': False, 'releasePerformanceAccepted': False, 'productionReady': False,
    'authoredFileHashes': {p: sha(read(p)) for p in [handbook_name, 'docs/管理后台开发任务清单.md']},
}
(ROOT / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
