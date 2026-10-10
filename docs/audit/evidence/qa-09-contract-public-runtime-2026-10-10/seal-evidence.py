"""Read-only local evidence revalidation and fresh seal. No cloud calls."""
from pathlib import Path
import json,hashlib,subprocess,os,re
from datetime import datetime,timezone
root=Path(__file__).resolve().parent;repo=root.parents[3]
def read(p):return json.loads(p.read_text())
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert not (root/'manifest.json').exists()
base=read(root/'baseline-binding.json')
for row in base['prior']:
 prior=repo/row['root'];manifest=read(prior/'manifest.json')
 assert len(manifest['files'])==row['filesVerified']
 for p,h in manifest['files'].items():assert digest(prior/p)==h,(prior,p)
for p,h in base['bindings'].items():assert digest(repo/p)==h,p
matrix=root/'matrix-final-validated';m=read(matrix/'matrix.json')
assert m['budget']=={'childProcesses':8,'concurrency':1,'childDeadlineMs':45000,'poolMax':1,'networkRequests':0,'databaseServers':0,'targetFixtures':0}
for row in m['inputs']:assert digest(repo/row['path'])==row['sha256'],row['path']
for row in m['rows']:assert digest(matrix/row['receipt'])==row['sha256'],row['case']
env=dict(os.environ);env['PATH']='/Users/anray/.nvm/versions/node/v24.12.0/bin:'+env['PATH']
code="""import {readFileSync} from 'node:fs';
import {publicCases,summarizePublicCase} from './scripts/run-qa09-contract-public-runtime.mjs';
const root=process.argv[1],m=JSON.parse(readFileSync(root+'/matrix.json'));
if(JSON.stringify(publicCases)!==JSON.stringify(m.rows.map(r=>r.case)))throw Error('CASE_BUDGET');
for(const r of m.rows)if(JSON.stringify(summarizePublicCase(JSON.parse(readFileSync(root+'/'+r.receipt))))!==JSON.stringify(r.samples))throw Error('SUMMARY_DRIFT');
console.log(JSON.stringify({gate:'PASS',cases:m.rows.length,scope:'LOCAL_RECEIPTS_ONLY'}));"""
run=subprocess.run(['node','--input-type=module','-e',code,str(matrix)],cwd=repo,env=env,capture_output=True,text=True)
assert run.returncode==0,run.stderr;(root/'receipt-revalidation.json').write_text(run.stdout)
a=read(root/'local-checks.json');b=read(root/'remaining-checks.json');c=read(root/'loopback-checks.json');d=read(root/'final-checks.json');e=read(root/'late-checks.json')
assert a['gate']==b['gate']=='FAIL' and a['results'][-1]['name']=='lint' and b['results'][-1]['name']=='remaining-test'
assert all(r['exitCode']==0 for r in a['results'][:-1]+b['results'][:-1])
assert c['gate']==d['gate']==e['gate']=='PASS' and all(r['exitCode']==0 for r in c['results']+d['results']+e['results'])
test=(root/'remaining-test.stdout.log').read_text()
assert '1560 passed (1560)' in test and 'tests 302' in test and 'pass 861' in test and 'fail 3' in test and 'listen EPERM' in test
assert 'tests 864' in (root/'loopback-test-scripts.stdout.log').read_text() and 'fail 0' in (root/'loopback-test-scripts.stdout.log').read_text()
assert '48 passed (48)' in (root/'late-focused-app.stdout.log').read_text()
assert 'tests 59' in (root/'final-focused-scripts.stdout.log').read_text() and 'fail 0' in (root/'final-focused-scripts.stdout.log').read_text()
assert '36 passed' in (root/'loopback-check-admin-web-e2e.stdout.log').read_text()
obs=read(root/'observations.json');assert obs['matrixSha256']==digest(matrix/'matrix.json')
assert obs['totals']=={'begin':16,'commit':12,'rollback':4,'checkout':24,'release':24,'dispose':8,'pools':8,'network':0}
gates=root/'gates';gates.mkdir()
for name in ['device-contracts','iot-integration','core-api-integration','admin-e2e-suite','security-suite','reliability-suite','prototype-regression']:
 p=Path('/tmp/fdp-public-runtime-test-'+name+'.json');assert p.exists();receipt=read(p);assert receipt.get('gate',receipt.get('status'))=='PASS',name
 (gates/p.name).write_bytes(p.read_bytes())
(root/'effective-checks.json').write_text(json.dumps({'gate':'PASS','scope':'VERIFY_EQUIVALENT_LOCAL_AND_FINAL_AFFECTED_CHECKS',
 'applicationTests':1560,'contractTests':302,'scriptTests':864,'mainE2eTests':36,'focusedApplicationTests':48,'focusedScriptTests':59,
 'qa02Through08':'PASS_LOCAL_ONLY','originalLocalGate':'FAIL','originalFailures':['test logger empty-loop lint corrected','3 sandbox loopback listen EPERM retained'],
 'recovery':'Remaining checks resumed from lint; after application/contract PASS only scripts rerun with loopback and remaining gates continued; final affected checks/matrix rerun after controlled cost-location assertions.',
 'buildExclusion':'Unrelated user-owned untracked build/ excluded only from eslint/prettier.',
 'targetGate':'NOT_RUN','p95Accepted':False,'fullQa09Accepted':False},indent=2)+'\n')
paths=subprocess.check_output(['git','diff','--name-only','-z'],cwd=repo).decode().split('\0')
paths+=subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z','packages/database/test','scripts','docs/dev','docs/audit/QA-09-合同公开运行时接缝默认关闭接线实施记录-2026-10-10.md'],cwd=repo).decode().split('\0')
paths=sorted(set(p for p in paths if p))
docs=[p for p in paths if p.startswith('docs/')]
for p in docs:
 for link in re.findall(r'\]\(([^)]+)\)',(repo/p).read_text()):
  if '://' not in link and not link.startswith('#'):
   assert (repo/p).parent.joinpath(link.split('#')[0]).exists(),(p,link)
for p in root.rglob('*.py'):compile(p.read_text(),str(p),'exec')
files={str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file()}
manifest={'gate':'PASS','scope':'LOCAL_NO_FORCED_YIELD_PUBLIC_SEAMS_AND_DEFAULT_OFF_WIRING_ONLY','sealedAt':datetime.now(timezone.utc).isoformat(),
 'baseCommit':'a880042b1c5a009e7989b2e8b15140906383a040','fileCount':len(files),'files':files,
 'sourceBindings':{p:digest(repo/p) for p in paths if not p.startswith('docs/')},'documentBindings':{p:digest(repo/p) for p in docs},
 'priorEvidenceFilesVerified':sum(r['filesVerified'] for r in base['prior']),
 'targetRuntimeWiring':'IMPLEMENTED_DEFAULT_OFF_LOCAL_VALIDATION_ONLY','targetGate':'NOT_RUN','qa09Gate':'PARTIAL',
 'afterQueueAttribution':'UNRESOLVED_NO_STABLE_COMPILER_SEAM','transportAttribution':'UNRESOLVED_NO_NEW_REQUESTS',
 'compilerOnlyAttribution':False,'serverExecutionIsolated':False,'p95Accepted':False,'fullQa09Accepted':False}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'gate':'PASS','files':len(files),'sourceBindings':len(manifest['sourceBindings']),'targetGate':'NOT_RUN'}))
