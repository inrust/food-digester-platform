"""Byte-bound descriptive findings only; no matched-cold or causal benefit claim."""
import json,hashlib
from pathlib import Path
r=Path(__file__).parent;bindings={}
def read(name):
 b=(r/name).read_bytes();bindings[name]=hashlib.sha256(b).hexdigest();return json.loads(b)
x=read('comparison.json');topology=read('c1/initial-topology-gate.json');analysis=read('c1/baseline-cold-analysis.json')
assert x['gate']=='PARTIAL' and topology['gate']=='PASS' and topology['observed']==2
cold=[q for q in analysis['rows'] if q['status']==409 and q['coldStart'] and 'initDurationMs' in q['platformReport']]
assert len(cold)==1 and x['modes']['c0']['baselineCold']=='NOT_OBSERVED'
c=cold[0];assert c['authenticatedPreconnectMs']==901 and c['firstConnectionMs']==0 and c['clientPreparationMs']==722
rows=x['modes']['c1']['records'];t=max(rows,key=lambda q:(q.get('clientTransport') or {}).get('tlsMs') or 0)
assert t['clientTransport']['reusedSocket'] is False and t['clientTransport']['tlsMs']==1722
assert t['requestId']!=c['requestId'] and c['clientTransport']['reusedSocket'] is True
out={'gate':'PARTIAL','scope':'EXISTING_REQUESTS_DESCRIPTIVE_REMAINDER_AND_SEPARATE_TRANSPORT_ONLY','sourceCommit':x['sourceCommit'],'cold409':{k:c[k] for k in ['requestId','clientMs','gatewayMs','lambdaMs','runtimeAssembly','enginePrepareMs','engineAfterAdapterMs','authenticatedPreconnectMs','clientPreparationMs','hookMs','accountQueryMs','firstDriverQueryMs','firstConnectionMs','clientTransport','platformReport']},'separateTlsTail':{k:t[k] for k in ['requestId','status','clientMs','gatewayMs','applicationMs','clientTransport']},'findings':['C1 real preconnect topology observed twice; no corresponding C0 cold409 sample','First business checkout observed as 0ms; 722ms first model preparation persists after preconnect settlement','Independent reused-socket cold409 and non-reused TCP/TLS tail are separate requests; no network node attribution'],'candidateDefaultOff':True,'causalBenefit':'NOT_ESTABLISHED','p95Accepted':False,'bindings':bindings}
assert not (r/'descriptive-findings.json').exists();(r/'descriptive-findings.json').write_text(json.dumps(out,indent=2)+'\n');print('descriptive findings PARTIAL')
