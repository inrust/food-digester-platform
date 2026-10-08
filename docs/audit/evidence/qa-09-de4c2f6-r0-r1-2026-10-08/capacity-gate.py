import json,sys,hashlib
from pathlib import Path
p=Path(sys.argv[1]); source=p/'capacity-before.json';v=json.loads(source.read_text());r=v['result']
assert v['gate']=='PASS' and r['gate']=='PASS' and r['action']=='capacity-readonly' and r['transactionReadOnly'] is True and r['writes']==0
s={i['name']:int(i['setting']) for i in r['settings']}; maximum=s['max_connections'];reserved=sum(s[k] for k in ['superuser_reserved_connections','reserved_connections','rds.rds_reserved_connections']);usable=maximum-reserved
assert usable==70
clients=sum(int(i['connections']) for i in r['sessions'] if i['backend_type']=='client backend');assert clients<=usable
out={'gate':'PASS','scope':'READ_ONLY_CAPACITY_SNAPSHOT','maxConnections':maximum,'reserved':reserved,'usableConnections':usable,'staticConnectionBudget':63,'snapshotClientConnections':clients,'peakProven':False,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest()}
(p/'capacity-before-gate.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
