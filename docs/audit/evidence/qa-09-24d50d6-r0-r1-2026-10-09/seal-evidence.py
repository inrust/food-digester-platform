"""Seal only this new root after both owned units and actual default-off recovery."""
import json,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;sha='24d50d6c3a9000c629d8255f78ea8d57a9d5b3f7'
for mode,name in [('r0','unit-completion.json'),('r1','unit-completion.json'),('restore','restore-completion.json')]:
 p=root/mode;v=json.loads((p/name).read_text());assert v['gate']=='PASS' and v['sourceCommit']==sha
 for n,h in v['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,'UNIT_BYTES_DRIFT'
v=json.loads((root/'comparison.json').read_text());assert v['gate']=='PARTIAL' and v['restoreGate']=='PASS'
for n,h in v['bindings'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==h,'COMPARISON_BYTES_DRIFT'
assert json.loads((root/'final-checks/summary.json').read_text())['gate']=='PASS'
entry=json.loads((root/'preflight/entry-gate.json').read_text());assert entry['gate']=='PASS' and entry['originalProbeGate']=='FAIL_START_OUTCOME_UNCONFIRMED' and entry['originalPlanRestarted'] is False
for n,h in entry['bindings'].items():assert hashlib.sha256((root/'preflight'/n).read_bytes()).hexdigest()==h,'ENTRY_EXCEPTION_BYTES_DRIFT'
terminal=json.loads((root/'restore/owned-build-terminal-bounded.json').read_text());assert terminal['gate']=='PASS' and terminal['originalUnknownStartResolved'] is False
domain=json.loads((root/'restore/owned-domain-readonly.json').read_text());assert domain['gate']=='PASS' and len(domain['prefixes'])==2 and all(x['versionsRemaining']==0 for x in domain['observations'])
for n,h in domain['bindings'].items():assert hashlib.sha256((root/n).read_bytes()).hexdigest()==h,'RESTORED_DOMAIN_BYTES_DRIFT'
for mode in ['r0','r1']:
 transport=json.loads((root/mode/'transport-observations.json').read_text());assert transport['gate']=='PASS' and transport['requestCount']==55 and transport['additionalRequests']==0
 for n,h in transport['bindings'].items():assert hashlib.sha256((root/mode/n).read_bytes()).hexdigest()==h,'TRANSPORT_BYTES_DRIFT'
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log','seal.exit']}
result={'gate':'PARTIAL','scope':'NEW_R0_R1_BOUND_BUSINESS_PHASE_OWN_CLEANUP_AND_DEFAULT_OFF_RESTORE','sourceCommit':sha,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'r0Gate':'PASS','r1Gate':'PASS','restoreGate':'PASS','cleanupGate':'PASS','matchedNaturalColdGate':v['matchedNaturalColdGate'],'originalCapacityStart':'UNKNOWN_PRESERVED_USER_AUTHORIZED_INDEPENDENT_READ_ONLY_ENTRY','knownBuildsTerminal':'PASS','restoredBothOwnedDomainsEmpty':'PASS','causalBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'fileCount':len(files),'files':files}
assert not (root/'manifest.json').exists();(root/'manifest.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='files'}))
