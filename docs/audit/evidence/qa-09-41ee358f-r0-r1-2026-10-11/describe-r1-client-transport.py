"""Keep client transport evidence independent of missing sampled Lambda correlation; no network."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;p=root/'r1';out=p/'transport-partial-observations.json';assert not out.exists();bindings={};rows=[]
for n in ['baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json']:
 b=(p/n).read_bytes();bindings[n]=hashlib.sha256(b).hexdigest();v=json.loads(b)
 assert v['gate']==('PARTIAL' if n=='sampling-patch.json' else 'PASS')
 if n=='sampling-patch.json':assert v['logReadErrors']=={'lambda':'LOG_READ_TIMEOUT'}
 for x in v['records']:
  t=x['clientTransport'];physical=any(y.get('initDurationMs',0)>0 for y in x['platformReports']) if x['exactLinked'] else None
  rows.append({'group':n,'id':x['id'],'requestId':x['requestId'],'status':x['status'],'clientMs':x['latencyMs'],'lambdaExactLinked':x['exactLinked'],'physicalCold':physical,'applicationMs':x['lambda'][0]['elapsedMs'] if x['exactLinked'] else None,'gatewayIntegrationMs':int(x['gateway'][0]['integrationLatency']),'transport':t,'tcpOrTlsAtLeastOneSecond':any((t.get(k) or 0)>=1000 for k in ['tcpMs','tlsMs'])})
assert len(rows)==len({x['requestId'] for x in rows})==55
long=[x for x in rows if x['tcpOrTlsAtLeastOneSecond']]
v={'gate':'DESCRIPTIVE_ONLY','scope':'ALL_EXISTING_55_CLIENT_TRANSPORTS_43_EXACT_LAMBDA_12_UNKNOWN','sourceCommit':'41ee358fb92e4dae2ae4abba7eb9923996fe029b','prefix':v['prefix'],'requestCount':55,'exactLambdaCount':sum(x['lambdaExactLinked'] for x in rows),'unknownLambdaCount':sum(not x['lambdaExactLinked'] for x in rows),'longTailRequestCount':len(long),'longTailWithUnknownLambdaCount':sum(not x['lambdaExactLinked'] for x in long),'maxTcpMs':max(x['transport'].get('tcpMs') or 0 for x in rows),'maxTlsMs':max(x['transport'].get('tlsMs') or 0 for x in rows),'networkNodeAttribution':'UNRESOLVED','additionalRequests':0,'rows':rows,'bindings':bindings,'p95Accepted':False,'fullQa09Accepted':False}
out.write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({k:x for k,x in v.items() if k not in ['rows','bindings']}))
