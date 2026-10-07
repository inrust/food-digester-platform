"""Final audit-only validation after actual candidate false restoration."""
import ast,json,hashlib,re,subprocess
from pathlib import Path
r=Path(__file__).parent;repo=r.parents[3];d=r/'final-checks';d.mkdir(exist_ok=True)
assert json.loads((r/'restore/restore-gate.json').read_text())['gate']=='PASS'
commands={'evidence':['pnpm','check:evidence'],'secrets':['pnpm','check:secrets']}
for name,cmd in commands.items():
 with (d/(name+'.stdout.log')).open('w') as out,(d/(name+'.stderr.log')).open('w') as err:code=subprocess.run(cmd,stdout=out,stderr=err,cwd=repo).returncode
 (d/(name+'.exit')).write_text(str(code)+'\n');assert code==0,name
py=list(r.rglob('*.py'));js=list(r.rglob('*.mjs'))
for p in py:ast.parse(p.read_text(),filename=str(p))
for p in js:subprocess.run(['node','--check',str(p)],check=True,capture_output=True,cwd=repo)
report=repo/'docs/audit/QA-09-aa9b50e-C1续跑与候选拓扑目标复验-2026-10-07.md';text=report.read_text();assert '待最终核验' not in text and '待回执' not in text
links=[]
for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',text):
 if target.startswith(('https://','http://','#')):continue
 path=(report.parent/target.split('#')[0]).resolve();assert path.exists(),target;links.append(target)
docs=[report,repo/'docs/管理后台开发任务清单.md',repo/'docs/dev/QA-09-Admin-hook与C0-C1复验手册.md']
(d/'document-links-gate.json').write_text(json.dumps({'gate':'PASS','reportLinks':len(links),'targets':links,'documents':{str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in docs}},indent=2,ensure_ascii=False)+'\n')
assert (r/'input-phase-tests.exit').read_text().strip()=='0'
assert re.search(r'(?:#|ℹ) pass 22\b',(r/'input-phase-tests.stdout.log').read_text())
for filename in ['descriptive-findings.json','deployed-pair-gate.json','comparison.json']:
 x=json.loads((r/filename).read_text())
 for name,h in x['bindings'].items():assert hashlib.sha256((r/name).read_bytes()).hexdigest()==h
bindings={str(p.relative_to(d)):hashlib.sha256(p.read_bytes()).hexdigest() for p in d.iterdir() if p.is_file() and p.name!='summary.json'}
(d/'summary.json').write_text(json.dumps({'gate':'PASS','scope':'LOCAL_AUDIT_HELPERS_EVIDENCE_SECRETS_LINKS_AND_BYTES_ONLY','commands':commands,'pythonFiles':len(py),'nodeFiles':len(js),'localTests':22,'reportLinks':len(links),'bindings':bindings,'fullQa09Accepted':False,'p95Accepted':False},indent=2)+'\n');print('final checks PASS',len(py),len(js),len(links))
