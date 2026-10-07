"""Verify closed receipt bindings, then seal this bounded target run and local patch."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent
sha='8b3babbf7a8e9405e6cd42284cdca1085501345f'
for folder,name,gate in [('c0','unit-completion.json','PASS'),('c1','predeploy-failure-gate.json','BLOCKED_CI'),('restore','no-change-gate.json','PASS')]:
 p=root/folder;v=json.loads((p/name).read_text());assert v['gate']==gate and v['sourceCommit']==sha
 base=root if folder=='restore' else p
 for f,expected in v['bindings'].items():assert hashlib.sha256((base/f).read_bytes()).hexdigest()==expected,'RECEIPT_BYTE_DRIFT:'+f
local=json.loads((root/'local-verify/summary.json').read_text());assert local['gate']=='PASS' and local['exitCode']==0
assert hashlib.sha256(Path('apps/cloud-api/test/admin-runtime-initialization.test.ts').read_bytes()).hexdigest()==local['testFileSha256']
for g in local['gates']:assert g['status']=='PASS' and hashlib.sha256((root/g['file']).read_bytes()).hexdigest()==g['sha256']
assert not (root/'c1/sample.json').exists(),'NO_C1_BUSINESS_AFTER_CI_FAILURE'
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
result={'gate':'PARTIAL','scope':'C0_CLOSED_C1_PREDEPLOY_CI_BLOCKED_LOCAL_TEST_FIX_VERIFIED','sourceCommit':sha,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'c0Gate':'PASS','c1Gate':'BLOCKED_CI','c1TargetBusiness':'NOT_RUN','defaultOffAfterFailure':'PASS','localFixVerify':'PASS','fixtureCleanup':'PASS','c1FixtureCreated':False,'fullQa09Accepted':False,'p95Accepted':False,'fileCount':len(manifest),'files':manifest}
(root/'manifest.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='files'}))
