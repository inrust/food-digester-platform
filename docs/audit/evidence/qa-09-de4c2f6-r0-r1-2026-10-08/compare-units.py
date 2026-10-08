"""Compare bound target units; absence of matched cold is retained, never fabricated."""
import json,hashlib,subprocess
from pathlib import Path
root=Path(__file__).parent;sha='de4c2f6ab94462fb684a5e117edb474d42df035c';bindings={}
def read(path):
 b=(root/path).read_bytes();bindings[str(path)]=hashlib.sha256(b).hexdigest();return json.loads(b)
planned=read(Path('preflight/planned-inputs.json'));units={};artifacts={};observations={}
closed={m:json.loads((root/m/'unit-completion.json').read_text()) for m in ['r0','r1']}
sharedGroup='baseline' if all(v['baselineCold409']>0 for v in closed.values()) else ('sampling' if all(v['samplingCold409']>0 for v in closed.values()) else None)
for mode in ['r0','r1']:
 p=root/mode;unit=read(Path(mode)/'unit-completion.json');assert unit['gate']=='PASS' and unit['sourceCommit']==sha
 for n,h in unit['bindings'].items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
 units[mode]=unit
 version=read(Path(mode)/'application-version.json');artifacts[mode]=sorted([{k:a[k] for k in ['name','codeSha256','artifactSha256','s3Bucket','s3Key','runtime']} for a in version['lambdaArtifacts']],key=lambda a:a['name'])
 config=read(Path(mode)/'actual-config.json');assert config['gate']=='PASS' and config['config']['accountReadCandidate']==str(mode=='r1').lower()
 paths={'version':'application-version.json','deployment':'deployment-input-binding.json','config':'actual-config.json','concurrency':'actual-config.json','unit':'unit-completion.json','empty':'database-empty-audit.json','budget':'connection-budget-gate.json','child':'sample.json'}
 group=sharedGroup
 observations[mode]={'baselineCold409':unit['baselineCold409'],'samplingCold409':unit['samplingCold409'],'coldGroupSelected':group,'physicalColdGate':'PASS' if group else 'NOT_OBSERVED'}
 if group:
  paths.update(patch=group+'-patch.json',audit=group+'-audit.json')
  refs={k:{'path':v,'sha256':hashlib.sha256((p/v).read_bytes()).hexdigest()} for k,v in paths.items()}
  (p/'matched-manifest.json').write_text(json.dumps({'inputs':planned[mode],'receipts':refs},indent=2)+'\n')
  read(Path(mode)/'matched-manifest.json')
assert artifacts['r0']==artifacts['r1'],'ARTIFACT_SET_DRIFT'
assert units['r0']['finishedAt']<read(Path('r1/sample.json'))['startedAt'],'SEQUENCE_DRIFT'
args=['node','scripts/record-qa09-deployment-inputs.mjs','--account-read-pair',str(root/'r0/qa09-deployment-inputs.json'),str(root/'r1/qa09-deployment-inputs.json'),str(root/'deployed-pair-gate.json')]
(root/'deployed-pair.command.json').write_text(json.dumps(args)+'\n')
q=subprocess.run(args,capture_output=True,text=True);(root/'deployed-pair.stdout.log').write_text(q.stdout);(root/'deployed-pair.stderr.log').write_text(q.stderr);(root/'deployed-pair.exit').write_text(str(q.returncode)+'\n');assert q.returncode==0
read(Path('deployed-pair-gate.json'))
matched='NOT_OBSERVED'
if all(o['coldGroupSelected'] for o in observations.values()):
 args=['node','scripts/qa09-matched-cold-inputs.mjs','--pair',str(root/'r0/matched-manifest.json'),str(root/'r1/matched-manifest.json'),str(root/'matched-cold-pair.json')]
 (root/'matched-cold.command.json').write_text(json.dumps(args)+'\n');q=subprocess.run(args,capture_output=True,text=True)
 (root/'matched-cold.stdout.log').write_text(q.stdout);(root/'matched-cold.stderr.log').write_text(q.stderr);(root/'matched-cold.exit').write_text(str(q.returncode)+'\n')
 matched='INPUT_COMPATIBLE' if q.returncode==0 else 'FAILED_STRICT_CHECK'
 if q.returncode==0:read(Path('matched-cold-pair.json'))
restore=read(Path('restore/restore-completion.json'));assert restore['gate']=='PASS' and restore['sourceCommit']==sha
for n,h in restore['bindings'].items():assert hashlib.sha256((root/'restore'/n).read_bytes()).hexdigest()==h
result={'gate':'PARTIAL','scope':'NEW_SAME_SHA_R0_R1_BUSINESS_PHASE_CLEANUP_AND_DEFAULT_RESTORE','sourceCommit':sha,'inputPairGate':'PASS','targetVersionPairGate':'PASS','businessPairGate':'PASS','cleanupPairGate':'PASS','restoreGate':'PASS','matchedNaturalColdGate':matched,'coldObservations':observations,'causalBenefit':'NOT_ESTABLISHED','p95Accepted':False,'fullQa09Accepted':False,'bindings':bindings}
(root/'comparison.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
