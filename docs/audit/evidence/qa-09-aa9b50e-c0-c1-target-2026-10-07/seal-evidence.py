"""Verify closed C0, prebusiness C1 block, restored false, and exact file bytes."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;sha='aa9b50eb010e2a1735084be587613431e6664ed3'
for folder,name,expectedGate in [('c0','unit-completion.json','PASS'),('c1','prebusiness-block-gate.json','BLOCKED_SSO_RENEWAL'),('restore','restore-gate.json','PASS')]:
 p=root/folder;v=json.loads((p/name).read_text());assert v['gate']==expectedGate and v['sourceCommit']==sha
 for f,h in v['bindings'].items():assert hashlib.sha256((p/f).read_bytes()).hexdigest()==h,'RECEIPT_BYTE_DRIFT:'+f
pair=json.loads((root/'deployed-pair-gate.json').read_text());assert pair['sourceCommit']==sha and pair['gate']=='PASS'
for f,h in pair['bindings'].items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==h
for f in ['sample.json','sample.json.fixtures.json','business-window.json']:assert not (root/'c1'/f).exists(),'NO_C1_FIXTURE_AFTER_PREFLIGHT_BLOCK'
assert (root/'input-phase-tests.exit').read_text().strip()=='0'
for mode in ['c0','c1','restore']:
 receipts=list((root/mode).glob('hosted-verify-*.json'));assert len(receipts)==1 and json.loads(receipts[0].read_text())['gate']=='PASS'
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
result={'gate':'PARTIAL','scope':'C0_CLOSED_C1_DEPLOYED_PREBUSINESS_SSO_BLOCKED_AND_DEFAULT_OFF_RESTORED','sourceCommit':sha,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'c0Gate':'PASS','c1DeploymentGate':'PASS','c1BusinessGate':'NOT_RUN','c1BlockGate':'BLOCKED_SSO_RENEWAL','restoreGate':'PASS','fixtureCleanup':'PASS','c1FixtureCreated':False,'fullQa09Accepted':False,'p95Accepted':False,'candidateTargetBenefit':'NOT_ESTABLISHED','fileCount':len(manifest),'files':manifest}
assert not (root/'manifest.json').exists(),'PRESERVE_SEALED_MANIFEST'
(root/'manifest.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='files'}))
