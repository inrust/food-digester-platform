"""Close observed inputs/business/cleanup/restore while preserving failed full R1 phase gate."""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parent;sha='41ee358fb92e4dae2ae4abba7eb9923996fe029b';bindings={}
assert not (root/'comparison.json').exists()
def read(n):
 b=(root/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();return json.loads(b)
def bound(n,base):
 v=read(n);assert v['gate']=='PASS'
 for f,h in v['bindings'].items():assert hashlib.sha256((root/base/f).read_bytes()).hexdigest()==h
 return v
r0=bound('r0/unit-completion.json','r0');r1=bound('r1/cleanup-only-completion.json','r1');restore=bound('restore/restore-completion.json','restore')
assert r0['sourceCommit']==r1['sourceCommit']==restore['sourceCommit']==sha
assert r0['businessChecks']==r1['businessChecks']==123 and r0['cleanup']==r1['cleanup']=='PASS'
assert r1['stageGate']==r1['logReadRecoveryGate']=='FAIL'
assert r0['finishedAt']<read('r1/sample.json')['startedAt']
assert r1['finishedAt']<read('restore/dispatch-run.json')['createdAt']
versions={m:read(m+'/application-version.json') for m in ['r0','r1','restore']}
for v in versions.values():assert v['gate']=='PASS' and v['sourceCommit']==sha and len(v['lambdaArtifacts'])==19
prior={a['name']:a for a in versions['r0']['lambdaArtifacts']}
for m,v in versions.items():
 for a in v['lambdaArtifacts']:
  assert all(a[k]==prior[a['name']][k] for k in ['codeSha256','artifactSha256','s3Bucket','s3Key','runtime'])
  if a['name']!='fdp-test-api':assert a['revisionId']==prior[a['name']]['revisionId']
 c=read(m+'/actual-config.json');assert c['gate']=='PASS'
 assert all(c['config'][k]==str(m!='restore').lower() for k in ['preconnect','accountReadCandidate','contractLoadDetail','contractPublicBoundaries'])
 assert c['config']['contractObserverCost']==str(m=='r1').lower()
args=['node','scripts/record-qa09-deployment-inputs.mjs','--observer-cost-pair',str(root/'r0/qa09-deployment-inputs.json'),str(root/'r1/qa09-deployment-inputs.json'),str(root/'deployed-pair-gate.json')]
assert not (root/'deployed-pair.exit').exists();(root/'deployed-pair.command.json').write_text(json.dumps(args)+'\n')
q=subprocess.run(args,capture_output=True,text=True);(root/'deployed-pair.stdout.log').write_text(q.stdout);(root/'deployed-pair.stderr.log').write_text(q.stderr);(root/'deployed-pair.exit').write_text(str(q.returncode)+'\n');assert q.returncode==0
read('deployed-pair-gate.json');baseline=read('r1/available-baseline-description.json');failure=read('r1/log-read-failure-classification.json')
assert baseline['baselinePhaseGate']=='PASS' and baseline['fullR1StageGate']=='FAIL' and failure['gate']=='FAIL'
for mode in ['r0','r1']:assert read(mode+'/connection-budget-gate.json')['gate']=='PASS'
observations={'gate':'NOT_RUN','reason':'FULL_R1_STAGE_GATE_FAILED_LOG_READ_TIMEOUT','availableR0BaselineCold409':r0['baselineCold409'],'availableR1BaselineCold409':sum(x['physicalCold'] and x['id'].startswith('race:') for x in baseline['summaries']),'samplingCold409':'NOT_EVALUATED','compilerOnlyAttribution':False,'p95Accepted':False,'fullQa09Accepted':False}
assert not (root/'observer-observations.json').exists();(root/'observer-observations.json').write_text(json.dumps(observations,indent=2)+'\n');read('observer-observations.json')
v={'gate':'PARTIAL','scope':'SAME_SHA_R0_CLOSED_R1_BUSINESS_CLEANUP_PASS_FULL_LOG_STAGE_FAIL_AND_OFF_RESTORE','sourceCommit':sha,'inputPairGate':'PASS','targetVersionPairGate':'PASS','businessPairGate':'PASS','cleanupPairGate':'PASS','fullPhasePairGate':'FAIL','originalR1LogCollectionGate':'FAIL','r1LogReadRecoveryGate':'FAIL','restoreGate':'PASS','matchedNaturalColdGate':'NOT_RUN','matchedNaturalColdReason':'FULL_R1_STAGE_GATE_FAILED_LOG_READ_TIMEOUT','extraSamples':0,'compilerOnlyAttribution':False,'causalBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'bindings':bindings}
(root/'comparison.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({k:x for k,x in v.items() if k!='bindings'}))
