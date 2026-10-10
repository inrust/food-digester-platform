"""Read-only verification and fresh offline evidence sealing; no cloud calls."""
from pathlib import Path
import hashlib, json, subprocess, os, re
from datetime import datetime, timezone
root = Path(__file__).resolve().parent
repo = root.parents[3]
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p): return json.loads(p.read_text())
assert not (root/'manifest.json').exists()
prior = repo/'docs/audit/evidence/qa-09-0afe483-r0-r1-2026-10-10'
previous = read(prior/'manifest.json')
assert len(previous['files']) == 822
for p,h in previous['files'].items(): assert digest(prior/p)==h,p
baseline = read(root/'baseline-binding.json')
for p,h in baseline['bindings'].items(): assert digest(repo/p)==h,p
old = read(prior/'contract-load-observations.json')
assert old['awaitR1'][0]['windowsMs']['contract-load-await-after-queue']==443
assert old['r1'][0]['driverQueryMs']==137 and old['r1'][0]['resultMs']==102
matrix = read(root/'matrix/matrix.json')
assert matrix['budget']=={'childProcesses':16,'concurrency':1,'childDeadlineMs':45000,'poolMax':1,'networkRequests':0,'databaseServers':0,'targetFixtures':0}
for row in matrix['inputs']: assert digest(repo/row['path'])==row['sha256'],row['path']
for row in matrix['rows']: assert digest(root/'matrix'/row['receipt'])==row['sha256'],row['case']
env=dict(os.environ)
env['PATH']='/Users/anray/.nvm/versions/node/v24.12.0/bin:'+env['PATH']
code="""import {readFileSync} from 'node:fs';
import {summarizeContractWindows,windowCases} from './scripts/qa09-contract-windows-proof.mjs';
const root=process.argv[1], matrix=JSON.parse(readFileSync(root+'/matrix/matrix.json'));
if(matrix.rows.map(r=>r.case).join(',')!==Object.keys(windowCases).join(','))throw Error('CASE_BUDGET');
for(const row of matrix.rows)if(JSON.stringify(summarizeContractWindows(JSON.parse(readFileSync(root+'/matrix/'+row.receipt))))!==JSON.stringify(row.samples))throw Error('SUMMARY_DRIFT');
console.log(JSON.stringify({gate:'PASS',cases:matrix.rows.length,scope:'LOCAL_RECEIPTS_ONLY'}));"""
run=subprocess.run(['node','--input-type=module','-e',code,str(root)],cwd=repo,env=env,capture_output=True,text=True)
assert run.returncode==0,run.stderr
(root/'receipt-revalidation.json').write_text(run.stdout)
initial=read(root/'local-checks.json'); remaining=read(root/'remaining-checks.json'); final=read(root/'final-checks.json')
assert initial['gate']=='FAIL' and initial['results'][-1]['name']=='test'
assert all(r['exitCode']==0 for r in initial['results'][:-1])
assert remaining['gate']==final['gate']=='PASS'
assert '1539 passed (1539)' in (root/'test.stdout.log').read_text()
assert 'tests 302' in (root/'test.stdout.log').read_text()
assert 'tests 838' in (root/'final-scripts.stdout.log').read_text()
assert 'fail 0' in (root/'final-scripts.stdout.log').read_text()
assert '36 passed' in (root/'check-admin-web-e2e.stdout.log').read_text()
summary=read(root/'observations.json')
assert summary['matrixSha256']==digest(root/'matrix/matrix.json')
assert summary['totals']['pools']==16 and summary['totals']['networkAttempts']==0
assert summary['totals']['checkout']==summary['totals']['release']==52
assert summary['totals']['commit']==30 and summary['totals']['rollback']==6
(root/'effective-checks.json').write_text(json.dumps({'gate':'PASS','scope':'VERIFY_EQUIVALENT_LOCAL_AND_FINAL_AFFECTED_CHECKS','applicationTests':1539,'contractTests':302,'finalScriptTests':838,'mainE2eTests':36,'focusedApplicationTests':31,'focusedScriptTests':28,'qa02Through08':'PASS_LOCAL_ONLY','originalSandboxGate':'FAIL','originalSandboxFailure':'3 local loopback listen EPERM failures retained','recovery':'Scripts rerun with loopback allowed; final same-Pool assertion and affected tests rerun; prior passed application/contract checks not replayed.','buildExclusion':'User-owned unrelated untracked build/ excluded only from eslint/prettier.','targetGate':'NOT_RUN','p95Accepted':False},indent=2)+'\n')
gates=root/'gates';gates.mkdir(exist_ok=True)
for row in remaining['results']:
 if row['name'].startswith('test-') and row['name']!='test-scripts-loopback':
  p=Path('/tmp/fdp-public-windows-'+row['name']+'.json')
  assert p.exists(),p
  (gates/p.name).write_bytes(p.read_bytes())
sources=[
 'scripts/qa09-contract-windows-proof.mjs','scripts/qa09-contract-windows-proof.d.mts',
 'scripts/qa09-contract-windows-proof.test.mjs','scripts/run-qa09-contract-windows-offline.mjs',
 'packages/database/test/contract-windows-offline.test.ts','packages/database/test/contract-window-probe.test.ts',
 'packages/database/test/helpers/contract-window-probe.ts',
]
documents=[
 'docs/管理后台开发任务清单.md','docs/dev/QA-09-合同三窗口公开分界与离线对照.md',
 'docs/audit/QA-09-合同三窗口预算内分界与离线对照实施记录-2026-10-10.md',
]
for doc in documents:
 for link in re.findall(r'\]\(([^)]+)\)',(repo/doc).read_text()):
  if '://' not in link and not link.startswith('#'):
   assert (repo/doc).parent.joinpath(link.split('#')[0]).exists(),(doc,link)
files={str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file()}
manifest={'gate':'PASS','scope':'OFFLINE_PUBLIC_BOUNDARIES_CONTROLLED_COST_LOCATION_ONLY','sealedAt':datetime.now(timezone.utc).isoformat(),'baseCommit':'402a699cf4ad3b5f0473b02fc51d56572fd32e4d','fileCount':len(files),'files':files,'sourceBindings':{p:digest(repo/p) for p in sources},'documentBindings':{p:digest(repo/p) for p in documents},'priorEvidenceFilesVerified':822,'historicalDocumentBindings':'Retained as original hashes; task list is append-only and has a new current binding.','targetRuntimeWiring':'NOT_IMPLEMENTED','targetGate':'NOT_RUN','qa09Gate':'PARTIAL','transportAttribution':'UNRESOLVED_NO_NEW_REQUESTS','compilerOnlyAttribution':False,'serverExecutionIsolated':False,'p95Accepted':False,'fullQa09Accepted':False}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'gate':'PASS','files':len(files),'targetGate':'NOT_RUN'}))
