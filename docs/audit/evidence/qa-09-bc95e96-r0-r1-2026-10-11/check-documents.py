"""Validate final repository document links and bind their exact bytes, locally."""
from pathlib import Path
import hashlib,json,re,urllib.parse,subprocess
root=Path(__file__).resolve().parent;repo=root.parents[3];out=root/'document-check.json';assert not out.exists()
report=repo/'docs/audit/QA-09-bc95e96公开入口有界摘要R0-R1目标复验-2026-10-11.md'
plan=repo/'docs/管理后台开发任务清单.md';text=report.read_text();assert '本轮序列 Gate：PASS' in text and 'QA-09 Gate：PARTIAL' in text
checked=[]
for target in re.findall(r'\]\(([^)]+)\)',text):
    if '://' in target or target.startswith('#'):continue
    clean=urllib.parse.unquote(target.split('#')[0]);p=(report.parent/clean).resolve()
    assert p.exists(),target
    checked.append(str(p.relative_to(repo)))
for mode in ['r0','r1']:
    u=json.loads((root/mode/'unit-completion.json').read_text());assert u['prefix'] in text and str(u['runId']) in text
v=json.loads((root/'restore/restore-completion.json').read_text());assert str(v['runId']) in text
baseline=subprocess.check_output(['git','show','bc95e9671a0bfb69effa95ad7c315b375199f132:docs/管理后台开发任务清单.md'],cwd=repo)
assert plan.read_bytes()==baseline,'HISTORICAL_IMPLEMENTATION_SEALED_TASK_LIST_MUST_REMAIN_UNCHANGED'
files=[report]
result=dict(gate='PASS',scope='LOCAL_FINAL_REPORT_LINKS_AND_DOCUMENT_BYTE_BINDINGS_ONLY',sourceCommit='bc95e9671a0bfb69effa95ad7c315b375199f132',localLinksChecked=len(checked),links=checked,historicalTaskListUnchanged=True,taskListSourceCommit='bc95e9671a0bfb69effa95ad7c315b375199f132',documentBindings={str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},p95Accepted=False,fullQa09Accepted=False)
out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(dict(gate='PASS',localLinksChecked=len(checked))))
