"""Prepare only fresh same-SHA helpers; immutable predecessor receipts stay untouched."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;repo=root.parents[3]
old=repo/'docs/audit/evidence/qa-09-ebbcfc0-r0-r1-2026-10-12'
older=repo/'docs/audit/evidence/qa-09-41ee358f-r0-r1-2026-10-11'
sha='f7f996f278877cb57fc9d400f8f1d24b6ff5ff48'
for mode in ['preflight','default-off','r0','r1','restore']:(root/mode).mkdir(exist_ok=True)
keys=json.loads((old/'preflight/entry-scope.json').read_text())['entryHelpers']
rows=[]
def adapt(text):
 return text.replace(str(old.relative_to(repo)),str(root.relative_to(repo))).replace(str(older.relative_to(repo)),str(root.relative_to(repo))).replace('ebbcfc0ee31673b3332b217ca757e6aa1ea6013d',sha).replace('41ee358fb92e4dae2ae4abba7eb9923996fe029b',sha).replace('38184960795','38195152567').replace('38136163697','38195152567').replace('38184960835','38195152562').replace('38136163699','38195152562')
for name in keys:
 if name=='prepare-helpers.py':continue
 p=root/name;assert not p.exists(),name
 origin=old/name
 s=adapt(origin.read_text())
 if name in ['prepare-entry.py','run-unit.py','check-artifact-transition.py']:
  s=s.replace('application-version-after-ci.json','application-version.json')
 if name=='close-entry.py':
  origin=older/name;s=adapt(origin.read_text())
  s=s.replace("args=['node','scripts/check-qa09-owned-summary.mjs','docs/audit/evidence/qa-09-owned-summary-2026-10-11']","args=['python3',str(root/'check-implementation-seal.py')]")
  s=s.replace("['gate']=='LOCAL_OWNED_SUMMARY_PASS'","['gate']=='LOCAL_AUXILIARY_BATCH_CANDIDATE_PASS'")
  s=s.replace("assert read('preflight/helper-input-check.json')['gate']=='LOCAL_PREFLIGHT_HELPER_CHECK_PASS'", "helperProof=read('preflight/helper-input-check.json');assert helperProof['gate']=='LOCAL_PREFLIGHT_HELPER_CHECK_PASS'\nfor n,h in helperProof['bindings'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==h\nfor n,h in helperProof['repositoryDependencies'].items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h")
 if name=='finish-unit.py':
  s=s.replace("call('collect-negative'", "call('initial-read-budget',['node','scripts/check-qa09-auxiliary-read.mjs',str(p/'sample.json'),str(p/'initial-phases.json'),str(p/'sample.json.fixtures.json')])\ncall('collect-negative'",1)
  s=s.replace("call('check-negative'", "call('negative-read-budget',['node','scripts/check-qa09-auxiliary-read.mjs',str(p/'negative-get.json'),str(p/'negative-phases.json')])\ncall('check-negative'",1)
 if name=='complete-unit.py':
  marker="peak=read('connection-budget-gate.json')"
  s=s.replace(marker,"for name in ['initial-read-budget','negative-read-budget']:\n proof=read(name+'.closure.stdout.log');assert proof['gate']=='PASS' and proof['scope']=='BOUNDED_OWN_AUXILIARY_READ_AND_SOURCE_BYTES_ONLY'\n assert (p/(name+'.closure.exit')).read_text().strip()=='0'\n"+marker)
 if name in ['verify-restored-owned-domain.mjs']:
  origin=older/name;s=adapt(origin.read_text())
 if name in ['final-checks.py','validate-current-pair.py']:
  s=s.replace("ci['attempt'] == 2","ci['attempt'] == 1").replace("== 'LOCAL_LOG_READ_BUDGET_PASS'","== 'LOCAL_AUXILIARY_BATCH_CANDIDATE_PASS'")
  s=s.replace("get('sealedFiles',160)","get('sealedFiles',702)").replace('implementation_count = 160','implementation_count = 702')
 if name.endswith('/collect-initial-phases.py') or name.endswith('/collect-negative-phases.py'):
  mode='initial' if 'initial' in name else 'negative'
  child='sample.json' if mode=='initial' else 'negative-get.json'
  output='initial-phases.json' if mode=='initial' else 'negative-phases.json'
  s='''"""Call the pushed repository collector through its isolated real CLI entry."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parent;repo=root.parents[4]
args=['python3','-I',str(repo/'scripts/collect-qa09-auxiliary-phases.py'),str(root/CHILD),str(root/OUTPUT),'--mode',MODE,'--expected-commit',SHA]
if MODE=='initial':args+=['--parent',str(root/'sample.json.fixtures.json')]
sys.exit(subprocess.run(args,cwd=repo).returncode)
'''.replace('CHILD',repr(child)).replace('OUTPUT',repr(output)).replace('MODE',repr(mode)).replace('SHA',repr(sha))
 if name=='check-helper-inputs.py':continue
 if name=='check-implementation-seal.py':continue
 p.write_text(s)
 rows.append({'path':name,'origin':str(origin.relative_to(repo)),'originSha256':hashlib.sha256(origin.read_bytes()).hexdigest(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(root/'preflight/helper-origins.json').write_text(json.dumps({'sourceCommit':sha,'helpers':rows,'newTargetReceiptsCopied':0},indent=2)+'\n')
print(json.dumps({'freshCopiedHelpers':len(rows),'sourceCommit':sha}))
