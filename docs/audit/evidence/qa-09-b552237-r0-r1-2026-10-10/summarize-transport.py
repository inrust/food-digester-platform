"""Summarize already bound requests; no network, new requests or node attribution."""
import hashlib,json,sys
from pathlib import Path

root=Path(__file__).parent
mode=sys.argv[1]
assert mode in ['r0','r1']
p=root/mode
output=p/'transport-observations.json'
assert not output.exists(),'PRESERVE_EXISTING_OBSERVATIONS'
unit=json.loads((p/'unit-completion.json').read_text())
assert unit['gate']=='PASS'
for name,digest in unit['bindings'].items():
 assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest
bindings={};rows=[]
for name in ['baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json']:
 data=(p/name).read_bytes();bindings[name]=hashlib.sha256(data).hexdigest()
 v=json.loads(data)
 assert v['gate']=='PASS' and v['sourceCommit']==unit['sourceCommit'] and v['prefix']==unit['prefix']
 for r in v['records']:
  assert r['exactLinked'] and len(r['lambda'])==1
  t=r['clientTransport'];cold=any(x.get('coldStart') is True for x in r['phases'])
  rows.append({'group':name,'id':r['id'],'requestId':r['requestId'],'status':r['status'],
   'physicalCold':any(x.get('initDurationMs') is not None for x in r['platformReports']),
   'applicationCold':cold,'clientMs':r['latencyMs'],'applicationMs':r['lambda'][0]['elapsedMs'],
   'transport':t,'tcpOrTlsAtLeastOneSecond':any(isinstance(t.get(k),(int,float)) and not isinstance(t.get(k),bool) and t[k]>=1000 for k in ['tcpMs','tlsMs'])})
assert len(rows)==55 and len({r['requestId'] for r in rows})==55
long=[r for r in rows if r['tcpOrTlsAtLeastOneSecond']]
out={'gate':'PASS','scope':'DESCRIPTIVE_EXISTING_55_REQUEST_TRANSPORT_OBSERVATIONS_ONLY',
 'sourceCommit':unit['sourceCommit'],'prefix':unit['prefix'],'requestCount':55,
 'longTailRequestCount':len(long),'warmLongTailRequestCount':sum(not r['physicalCold'] and not r['applicationCold'] for r in long),
 'maxTcpMs':max((r['transport'].get('tcpMs') or 0) for r in rows),
 'maxTlsMs':max((r['transport'].get('tlsMs') or 0) for r in rows),
 'networkNodeAttribution':'UNRESOLVED','additionalRequests':0,'p95Accepted':False,
 'fullQa09Accepted':False,'bindings':bindings,'rows':rows}
output.write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k not in ['bindings','rows']}))
