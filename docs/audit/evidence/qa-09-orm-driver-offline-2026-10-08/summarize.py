"""Offline byte-bound analysis only. No network, SDK or subprocess."""
import hashlib,json
from pathlib import Path
root=Path(__file__).parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
load=lambda p:json.loads(p.read_text())
old=Path('docs/audit/evidence/qa-09-17fb6f1-r0-r1-2026-10-08');seal=load(old/'manifest.json')
assert seal['sourceCommit']=='17fb6f10443f74d05ae3686928b9f2ed575d9b05'
assert all(seal[k]=='PASS' for k in ['r0Gate','r1Gate','restoreGate','cleanupGate'])
for name,digest in seal['files'].items():assert sha(old/name)==digest,name
matrix=load(root/'matrix-final/matrix.json');assert matrix['gate']=='PASS' and len(matrix['rows'])==8
bindings={'previousManifest':{'path':str(old/'manifest.json'),'sha256':sha(old/'manifest.json')},'previousObservations':{'path':str(old/'contract-load-observations.json'),'sha256':sha(old/'contract-load-observations.json')}}
for item in matrix['inputs']:assert sha(Path(item['path']))==item['sha256'],item['path']
for item in matrix['rows']:
 assert item['receipt']==item['case']+'.json'
 assert sha(root/'matrix-final'/item['receipt'])==item['sha256']
oldload=load(old/'contract-load-observations.json');assert oldload['matchedInputGate']=='INPUT_COMPATIBLE' and oldload['receiptBytesVerified'] is True
transports={}
for kind in ['node','curl']:
 p=root/(kind+'-transport.json');v=load(p);assert v['gate']=='PASS' and len(v['rows'])==(12 if kind=='node' else 6)
 for source in v['sources']:assert sha(Path(source['path']))==source['sha256']
 if kind=='node':
  assert v['budget']=={'requests':12,'maxConcurrency':6,'deadlineMs':20000} and v['peakConcurrency']<=6
  assert all(r['status']==401 and r['tls']['authorized'] is True and r['tls']['protocol'] in ['TLSv1.2','TLSv1.3'] for r in v['rows'])
 else:
  assert v['budget']=={'requests':6,'concurrency':1,'deadlineSeconds':20,'retries':0}
  assert all(r['status']==401 and r['sslVerifyResult']==0 and r['connections']==1 for r in v['rows'])
 rows=[r.get('clientTransport',r) for r in v['rows']]
 transports[kind]={'gate':'PASS','requests':len(rows),'maxTcpMs':max(r.get('tcpMs') or 0 for r in rows),'maxTlsMs':max(r.get('tlsMs') or 0 for r in rows),'atLeast1s':sum(any((r.get(k) or 0)>=1000 for k in ['tcpMs','tlsMs']) for r in rows),'eventLoop':v.get('eventLoop'),'networkNodeAttribution':'UNRESOLVED','p95Accepted':False}
 bindings[kind]={'path':str(p),'sha256':sha(p)}
p=root/'matrix-final/matrix.json';bindings['matrix']={'path':str(p),'sha256':sha(p)}
out={'gate':'PASS','scope':'OFFLINE_BOUNDARIES_CONTROLS_AND_INDEPENDENT_TRANSPORT_RECEIPTS_ONLY','previousSourceCommit':seal['sourceCommit'],'previousTargetWindows':{'ormPrepareMs':oldload['r1'][0]['ormPrepareMs'],'driverQueryMs':oldload['r1'][0]['driverQueryMs']},'offlineCases':8,'budget':matrix['budget'],'zeroDelayFirstContract':{row['case']:{'accountMs':row['accountMs'],'publicWaitMs':row['samples'][0]['durations']['returnToAdapterMs'],'adapterTotalMs':row['samples'][0]['durations']['adapterTotalMs']} for row in matrix['rows'] if row['case'].endswith('-zero')},'transports':transports,'bindings':bindings,'targetSubwindows':'NOT_RUN','targetEquivalent':False,'modelCostShift':'NOT_ESTABLISHED_FOR_TARGET','compilerOnlyAttribution':False,'serverExecutionIsolated':False,'p95Accepted':False,'fullQa09Accepted':False}
assert not (root/'summary.json').exists();(root/'summary.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
