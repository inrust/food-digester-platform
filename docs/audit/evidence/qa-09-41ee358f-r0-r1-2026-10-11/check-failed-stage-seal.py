"""Seal integrity and rollback evidence while retaining the failed R1 phase gate."""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parent;repo=root.parents[3];manifest=root/'manifest.json';report=repo/'docs/audit/QA-09-41ee358f自有边界摘要R0-R1目标复验-2026-10-11.md';sha='41ee358fb92e4dae2ae4abba7eb9923996fe029b'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def inventory():return {str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file() and p!=manifest}
assert sys.argv[1:] in [['--seal'],['--check']]
if sys.argv[1]=='--seal':
 assert not manifest.exists(),'NO_RESEAL'
 for n in ['r0/unit-completion.json','r1/cleanup-only-completion.json','restore/restore-completion.json','restore/post-restoration-readonly.json','restore/owned-domain-readonly.json','restore/owned-build-terminal-bounded.json','final-live-readonly.json','final-checks/summary.json']:assert json.loads((root/n).read_text())['gate']=='PASS',n
 comparison=json.loads((root/'comparison.json').read_text());assert comparison['gate']=='PARTIAL' and comparison['fullPhasePairGate']=='FAIL' and comparison['matchedNaturalColdGate']=='NOT_RUN' and not comparison['p95Accepted'] and not comparison['fullQa09Accepted']
 assert json.loads((root/'r1/cleanup-only-completion.json').read_text())['stageGate']=='FAIL'
 assert not (root/'r1/unit-completion.json').exists()
 v={'gate':'LOCAL_EVIDENCE_INTEGRITY_PASS','sourceCommit':sha,'boundedSequenceGate':'PARTIAL','r0StageGate':'PASS','r1StageGate':'FAIL','r1LogReadRecoveryGate':'FAIL','businessPairGate':'PASS','cleanupPairGate':'PASS','restoreGate':'PASS','originalArtifactDownloadGate':'FAIL','artifactReadRecovery':'PASS','matchedNaturalColdGate':'NOT_RUN','qa09Gate':'PARTIAL','p95Accepted':False,'fullQa09Accepted':False,'files':inventory(),'documents':{str(report.relative_to(repo)):digest(report)}}
 manifest.write_text(json.dumps(v,indent=2,ensure_ascii=False)+'\n')
v=json.loads(manifest.read_text());assert v['sourceCommit']==sha and v['files']==inventory(),'EVIDENCE_DRIFT'
assert v['gate']=='LOCAL_EVIDENCE_INTEGRITY_PASS' and v['boundedSequenceGate']==v['qa09Gate']=='PARTIAL' and v['r1StageGate']==v['r1LogReadRecoveryGate']=='FAIL'
assert v['businessPairGate']==v['cleanupPairGate']==v['restoreGate']=='PASS' and v['matchedNaturalColdGate']=='NOT_RUN' and v['p95Accepted'] is False and v['fullQa09Accepted'] is False
for n,h in v['documents'].items():assert digest(repo/n)==h,'REPORT_DRIFT'
print(json.dumps({k:x for k,x in v.items() if k not in ['files','documents']}|{'sealedFiles':len(v['files'])}))
