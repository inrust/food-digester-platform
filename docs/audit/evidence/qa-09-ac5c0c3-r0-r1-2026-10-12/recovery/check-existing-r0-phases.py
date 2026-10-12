"""Original request phase checks only; original failed unit is never upgraded."""
from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).parent.parent;p=root/'r0';d=root/'recovery';child=json.loads((p/'sample.json').read_text());assert child['gate']=='FAIL' and not child['cleanupComplete']
flags=['--account-phases','--client-preparation','--client-split','--contract-load-split','--contract-load-detail','--contract-await-checkpoint','--contract-public-boundaries','--runtime-assembly','--engine-cpu','--authenticated-preconnect']
for group in ['baseline','sampling']:
 name='r0-'+group+'-phases';out=d/(name+'.json');assert not out.exists() and not (d/(name+'.exit')).exists()
 args=['node','scripts/check-qa09-contract-phases.mjs',str(p/'sample.json'),str(p/(group+'-patch.json')),str(p/(group+'-audit.json')),str(out),*flags]+(['--cold-sampling'] if group=='sampling' else [])
 (d/(name+'.command.json')).write_text(json.dumps(args)+'\n');q=subprocess.run(args,capture_output=True,text=True);(d/(name+'.stdout.log')).write_text(q.stdout);(d/(name+'.stderr.log')).write_text(q.stderr);(d/(name+'.exit')).write_text(str(q.returncode)+'\n')
 if group=='baseline':assert q.returncode==0
 else:assert q.returncode!=0 and 'COLD_SAMPLING_FINAL_CHILD_REQUIRED' in q.stderr and not out.exists()
 print(name,q.returncode,flush=True)
rows=[];bindings={'sample.json':hashlib.sha256((p/'sample.json').read_bytes()).hexdigest()}
for n in ['baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json']:
 b=(p/n).read_bytes();j=json.loads(b);bindings[n]=hashlib.sha256(b).hexdigest();assert j['gate']=='PASS' and j['sourceReceiptSha256']==bindings['sample.json'];rows+=j['records']
assert len(rows)==55 and len({r['requestId'] for r in rows})==55
assert all(r['exactLinked'] and len(r['lambda'])==1 for r in rows)
patches=[r for r in rows if r['operationId']=='updateContract'];assert all(not r['contractObserverCost'] for r in patches)
long=[r for r in rows if any(isinstance(r['clientTransport'].get(k),(int,float)) and r['clientTransport'][k]>=1000 for k in ['tcpMs','tlsMs'])]
summary=dict(gate='PARTIAL',scope='READ_ONLY_ORIGINAL_FAILED_R0_EXISTING_REQUEST_OBSERVATIONS_ONLY',sourceCommit=child['sourceCommit'],prefix=child['prefix'],originalUnitGate='FAIL',exactPhaseRequests=55,additionalRequests=0,baselinePhaseGate='PASS',samplingFinalPhaseGate='BLOCKED',samplingFinalPhaseBlocker='COLD_SAMPLING_FINAL_CHILD_REQUIRED',observerOffNoSummaries=True,patchRequests=len(patches),longTailRequestCount=len(long),maxTcpMs=max((r['clientTransport'].get('tcpMs') or 0) for r in rows),maxTlsMs=max((r['clientTransport'].get('tlsMs') or 0) for r in rows),networkNodeAttribution='UNRESOLVED',r1Gate='NOT_RUN',matchedNaturalColdGate='NOT_RUN',p95Accepted=False,fullQa09Accepted=False,bindings=bindings)
(d/'r0-existing-observations.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({k:v for k,v in summary.items() if k!='bindings'}))
