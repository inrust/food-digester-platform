"""Byte-bound observer-only comparison after both original cleanups and off restore."""
import json,hashlib,subprocess
from pathlib import Path
root=Path(__file__).parent;sha='bc95e9671a0bfb69effa95ad7c315b375199f132';bindings={}
def read(path):
 b=(root/path).read_bytes();bindings[str(path)]=hashlib.sha256(b).hexdigest();return json.loads(b)
def call(name,args):
 assert not (root/(name+'.exit')).exists(),'NO_STEP_REPLAY'
 (root/(name+'.command.json')).write_text(json.dumps(args)+'\n');q=subprocess.run(args,capture_output=True,text=True)
 (root/(name+'.stdout.log')).write_text(q.stdout);(root/(name+'.stderr.log')).write_text(q.stderr);(root/(name+'.exit')).write_text(str(q.returncode)+'\n');return q.returncode
planned=read(Path('preflight/planned-inputs.json'));units={m:read(Path(m)/'unit-completion.json') for m in ['r0','r1']}
shared='baseline' if all(u['baselineCold409']>0 for u in units.values()) else ('sampling' if all(u['samplingCold409']>0 for u in units.values()) else None)
artifacts={};observations={}
for mode,u in units.items():
 p=root/mode;assert u['gate']=='PASS' and u['sourceCommit']==sha
 for n,h in u['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
 v=read(Path(mode)/'application-version.json');artifacts[mode]=sorted([{k:a[k] for k in ['name','codeSha256','artifactSha256','s3Bucket','s3Key','runtime']} for a in v['lambdaArtifacts']],key=lambda a:a['name'])
 c=read(Path(mode)/'actual-config.json');assert c['gate']=='PASS' and c['config']['accountReadCandidate']=='true' and c['config']['contractLoadDetail']=='true' and c['config']['contractPublicBoundaries']=='true' and c['config']['contractObserverCost']==str(mode=='r1').lower()
 observations[mode]={'baselineCold409':u['baselineCold409'],'samplingCold409':u['samplingCold409'],'coldGroupSelected':shared,'physicalColdGate':'PASS' if shared else 'NOT_OBSERVED'}
 if shared:
  paths={'version':'application-version.json','deployment':'deployment-input-binding.json','config':'actual-config.json','concurrency':'actual-config.json','unit':'unit-completion.json','empty':'database-empty-audit.json','budget':'connection-budget-gate.json','child':'sample.json','inputs':'qa09-deployment-inputs.json','patch':shared+'-patch.json','audit':shared+'-audit.json'}
  refs={k:{'path':v,'sha256':hashlib.sha256((p/v).read_bytes()).hexdigest()} for k,v in paths.items()}
  out=p/'matched-manifest.json';assert not out.exists();out.write_text(json.dumps({'inputs':planned[mode],'receipts':refs,**planned['manifestRequirements'],'contractReadCandidate':False},indent=2)+'\n');read(Path(mode)/out.name)
assert artifacts['r0']==artifacts['r1'],'ARTIFACT_SET_DRIFT'
assert units['r0']['finishedAt']<read(Path('r1/sample.json'))['startedAt'],'SEQUENCE_DRIFT'
assert call('deployed-pair',['node','scripts/record-qa09-deployment-inputs.mjs','--observer-cost-pair',str(root/'r0/qa09-deployment-inputs.json'),str(root/'r1/qa09-deployment-inputs.json'),str(root/'deployed-pair-gate.json')])==0
read(Path('deployed-pair-gate.json'));matched='NOT_OBSERVED'
if shared:
 code=call('observer-comparison',['node','scripts/analyze-qa09-contract-observer.mjs',str(root/'r0/matched-manifest.json'),str(root/'r1/matched-manifest.json'),str(root/'observer-observations.json')])
 if code==0:
  result=read(Path('observer-observations.json'));assert result['receiptBytesVerified'] is True and result['gate']=='INPUT_COMPATIBLE';matched='INPUT_COMPATIBLE'
 else:matched='FAILED_STRICT_CHECK'
else:
 (root/'observer-observations.json').write_text(json.dumps({'gate':'NOT_RUN','reason':'MATCHED_NATURAL_COLD_NOT_OBSERVED','compilerOnlyAttribution':False,'p95Accepted':False})+'\n');read(Path('observer-observations.json'))
restore=read(Path('restore/restore-completion.json'));assert restore['gate']=='PASS' and restore['sourceCommit']==sha and restore['contractObserverCost'] is False
for n,h in restore['bindings'].items():assert hashlib.sha256((root/'restore'/n).read_bytes()).hexdigest()==h
result={'gate':'PARTIAL','scope':'SAME_SHA_ACCOUNT_NATIVE_BOTH_OBSERVER_OFF_ON_ORIGINAL_BUSINESS_CLEANUP_AND_OFF_RESTORE','sourceCommit':sha,'inputPairGate':'PASS','targetVersionPairGate':'PASS','businessPairGate':'PASS','cleanupPairGate':'PASS','restoreGate':'PASS','matchedNaturalColdGate':matched,'coldObservations':observations,'compilerOnlyAttribution':False,'causalBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'bindings':bindings}
assert not (root/'comparison.json').exists();(root/'comparison.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
