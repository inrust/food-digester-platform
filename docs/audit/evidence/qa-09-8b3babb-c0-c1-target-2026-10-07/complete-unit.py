"""Seal an already completed bounded unit, without running probes or changing AWS."""
import json,sys,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent
mode=sys.argv[1]
assert mode in ('c0','c1')
p=root/mode
bindings={}
def read(name):
 b=(p/name).read_bytes();bindings[name]=hashlib.sha256(b).hexdigest();return json.loads(b)
initial,final=read('api-config.json'),read('api-final-config.json')
capacity,last=read('api-concurrency.json'),read('api-final-concurrency.json')
assert initial==final and capacity==last
assert initial['engineCpu']=='true' and initial['preconnect']==str(mode=='c1').lower()
assert initial['memory']==512 and initial['pool']=='1' and initial['envName']=='test'
assert capacity['ReservedConcurrentExecutions']==12
(p/'final-config-binding.json').write_text(json.dumps({'gate':'PASS','scope':'INITIAL_AND_FINAL_SAFE_API_CONFIG_AND_CAPACITY','bindings':dict(bindings)},indent=2)+'\n')
provenance=read('deployment-input-binding.json')
version=read('application-version.json')
negative=read('negative-gate.json')
wrapper=read('sample.json.gate.json')
empty=read('database-empty-audit.json')
for name in ('baseline-phases.json','sampling-phases.json'):
 assert read(name)['gate']=='PASS'
for name,group,analysis in [('baseline-cold-phases','baseline','baseline-cold-analysis'),('cold-phases','sampling','cold-analysis')]:
 proof=p/(name+'.json')
 if proof.exists():
  assert read(name+'.json')['gate']=='PASS'
 else:
  assert read(group+'-phases.json')['coldConflictObservedCount']==0
  code=p/(name+'.exit');error=p/(name+'.stderr.log')
  assert int(code.read_text())!=0 and 'COLD_CONFLICT_REQUIRED' in error.read_text()
  for f in (code,error):bindings[f.name]=hashlib.sha256(f.read_bytes()).hexdigest()
  absent=read(analysis+'.json')
  assert absent['gate']=='NOT_RUN' and absent['reason']=='COLD_CONFLICT_NOT_OBSERVED'

peak=read('connection-budget-gate.json')
assert peak['gate']=='PASS' and peak['observedMaximum']<=70
target=read('target-summary.json')
runtime=read('runtime-assembly-analysis.json')
for name in ('runtime-final-binding.json','final-config-binding.json','cdk-diff-summary.json'):
 assert read(name)['gate']=='PASS'
assert provenance['gate']=='PASS' and version['gate']=='PASS' and len(version['lambdaArtifacts'])==19
assert negative['gate']=='PASS' and wrapper['gate']=='PASS' and empty['gate']=='PASS'
assert target['businessGate']=='PASS' and target['cleanup']=='PASS' and target['businessChecks']==123
assert runtime['gate']=='PASS' and runtime['negativeNoSqlGate']=='PASS' and runtime['negativeRequests']==12
assert target['sourceCommit']==version['sourceCommit']=='8b3babbf7a8e9405e6cd42284cdca1085501345f'
result={'gate':'PASS','scope':'BOUNDED_'+mode.upper()+'_UNIT_VERSION_BUSINESS_PHASE_AND_OWN_CLEANUP_ONLY','sourceCommit':target['sourceCommit'],'runId':provenance['runId'],'prefix':target['prefix'],'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'businessChecks':target['businessChecks'],'negativeRequests':12,'exactPhaseRequests':target['phaseRequests']+target['samplingPhaseRequests'],'runtimeObserved':runtime['runtimeObserved'],'baselineCold409':target['baselineColdConflictObservedCount'],'samplingCold409':target['samplingColdConflictObservedCount'],'cleanup':'PASS','independentEmptyAudit':'PASS','bindings':bindings,'fullQa09Accepted':False,'p95Accepted':False}
assert result['exactPhaseRequests']==55
assert not (p/'unit-completion.json').exists(), 'PRESERVE_EXISTING_CLOSURE'
(p/'unit-completion.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='bindings'}))
