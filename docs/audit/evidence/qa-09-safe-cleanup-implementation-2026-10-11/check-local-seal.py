"""Local byte/content seal only; no network, target execution or acceptance upgrade."""
from pathlib import Path
import hashlib,json,re,sys,subprocess,urllib.parse
root=Path(__file__).resolve().parent;repo=root.parents[3]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(n):return json.loads((root/n).read_text())
mode=sys.argv[1] if len(sys.argv)==2 else '';assert mode in ['--seal','--check']
manifest=root/'manifest.json'
if mode=='--check':
 v=read('manifest.json');assert v['gate']=='LOCAL_IMPLEMENTATION_PASS' and v['targetRun']=='NOT_RUN' and not v['fullQa09Accepted']
 assert {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}==set(v['files'])|{'manifest.json'}
 for n,h in v['files'].items():assert digest(root/n)==h,n
 for n,h in v['bindings'].items():assert digest(repo/n)==h,n
 print(json.dumps(dict(gate='LOCAL_IMPLEMENTATION_PASS',sealedFiles=len(v['files']),targetRun='NOT_RUN',fullQa09Accepted=False)));raise SystemExit(0)
assert not manifest.exists()
source=read('verification-source.json')['files']
for n,h in source.items():assert digest(repo/n)==h,n
plan=read('full-verify/verify-plan.json');verify=read('full-verify/verify-results.json')
expected=json.loads((repo/'package.json').read_text())['scripts']['verify'].split(' && ')
expected[0]='pnpm exec eslint . --ignore-pattern build/**';expected[1]="pnpm exec prettier --check . '!build/**'"
assert plan['commands']==expected and verify['gate']=='PASS' and len(verify['steps'])==len(expected)==22
assert [x['command'] for x in verify['steps']]==expected and all(x['gate']=='PASS' and x['exit']==0 for x in verify['steps'])
assert read('focused-results.json')['focused']['tests']==99 and read('matrix.json')['newCases']==48
assert all(x['gate']=='PASS' for k in ['cognitoCases','unknownStartCases'] for x in read('matrix.json')[k])
log=(root/'full-verify/verify-05.log').read_text();assert 'Tests  1637 passed (1637)' in log and 'ℹ pass 1018' in log and 'ℹ fail 0' in log
historical=0
for directory in ['qa-09-bc95e96-r0-r1-2026-10-11','qa-09-observer-cost-implementation-2026-10-11']:
 p=root.parent/directory;v=json.loads((p/'manifest.json').read_text())
 for n,h in v['files'].items():assert digest(p/n)==h,n;historical+=1
 for n,h in v.get('documentBindings',{}).items():assert digest(repo/n)==h,n
planFile=repo/'docs/管理后台开发任务清单.md'
assert planFile.read_bytes()==subprocess.check_output(['git','show','0af53c7a02e53f681cdbd111f905b2c87124bb53:docs/管理后台开发任务清单.md'],cwd=repo)
documents=['docs/audit/QA-09-Cognito安全分类与未知启动实施记录-2026-10-11.md','docs/dev/QA-09-Cognito安全分类与未知启动复验.md']
links=0
for n in documents:
 p=repo/n;text=p.read_text();assert 'NOT_RUN' in text
 for target in re.findall(r'\]\(([^)]+)\)',text):
  if '://' in target or target.startswith('#'):continue
  assert (p.parent/urllib.parse.unquote(target.split('#')[0])).resolve().exists(),target;links+=1
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
for p in [*(p for p in root.rglob('*') if p.is_file()),*(repo/n for n in [*source,*documents])]:
 assert not any(rx.search(p.read_bytes()) for rx in patterns),p
subprocess.run(['git','diff','--check'],cwd=repo,check=True)
summary=dict(gate='LOCAL_IMPLEMENTATION_PASS',scope=plan['scope'],verifySteps=22,focusedTests=99,newMatrixCases=48,authRegressionTests=28,vitestTests=1637,contractTests=302,scriptTests=1018,historicalEvidenceFilesVerified=historical,documentLinksChecked=links,secretPatternHits=0,targetRun='NOT_RUN',qa09Gate='PARTIAL',p95Accepted=False,fullQa09Accepted=False)
(root/'implementation.json').write_text(json.dumps(summary,indent=2)+'\n')
files={str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file()}
v=dict(gate='LOCAL_IMPLEMENTATION_PASS',files=files,bindings={**source,**{n:digest(repo/n) for n in documents}},targetRun='NOT_RUN',fullQa09Accepted=False,p95Accepted=False)
manifest.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');print(json.dumps(summary))
