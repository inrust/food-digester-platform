"""Check the failed original stage and completed cleanup/restoration without promoting it."""
import ast,base64,hashlib,json,re,subprocess
from pathlib import Path
root=Path(__file__).parent;out=root/'final-checks';out.mkdir(exist_ok=True);assert not (out/'summary.json').exists()
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
files=sorted(p for p in root.rglob('*') if p.is_file());py=node=decoded=0
for p in files:
 data=p.read_bytes();assert not any(x.search(data) for x in patterns),'SECRET_PATTERN:'+str(p)
 if p.suffix=='.py':ast.parse(data,filename=str(p));py+=1
 elif p.suffix=='.mjs':
  q=subprocess.run(['node','--check',str(p)],capture_output=True);assert q.returncode==0,'NODE_SYNTAX:'+str(p);node+=1
 if p.suffix=='.json':
  value=json.loads(data)
  def walk(v):
   global decoded
   if isinstance(v,dict):
    for k,item in v.items():
     if k=='source' and isinstance(item,dict) and item.get('type')=='NO_SOURCE':
      for t in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}',item.get('buildspec','')):
       try:b=base64.b64decode(t,validate=True)
       except ValueError:continue
       assert not any(x.search(b) for x in patterns),'DECODED_SECRET';decoded+=1
     walk(item)
   elif isinstance(v,list):
    for item in v:walk(item)
  walk(value)
for mode,n in [('r0','cleanup-only-completion.json'),('restore','restore-completion.json'),('restore','post-restoration-readonly.json')]:
 v=json.loads((root/mode/n).read_text());assert v['gate']=='PASS'
 for key,d in v['bindings'].items():assert hashlib.sha256((root/mode/key).read_bytes()).hexdigest()==d,'RECEIPT_BYTES_DRIFT'
wrapper=json.loads((root/'r0/sample.json.gate.json').read_text());assert wrapper['gate']=='FAIL' and wrapper['reason']=='EXECUTED_SOURCE_DRIFT'
assert not (root/'r1/dispatch.exit').exists() and not (root/'r1/sample.json').exists()
for n in ['owned-build-terminal-bounded.json','owned-domain-readonly.json']:assert json.loads((root/'restore'/n).read_text())['gate']=='PASS'
sha='f7abb0670398a1254fcf45755f077b41f4fcd4c0';q=subprocess.run(['git','diff',sha,'--','apps','packages','contracts','infra','scripts','.github','package.json','pnpm-lock.yaml'],capture_output=True);assert q.returncode==0 and not q.stdout,'APPLICATION_SOURCE_DRIFT_DURING_TARGET_VERIFICATION'
result={'gate':'PASS','scope':'LOCAL_SYNTAX_HYGIENE_FAILURE_PRESERVATION_AND_RESTORATION_BINDINGS_ONLY','sourceCommit':sha,'filesScanned':len(files),'pythonAst':py,'nodeSyntax':node,'decodedSourcesScanned':decoded,'secretPatternHits':0,'originalExecutionGate':'FAIL','r1Gate':'NOT_RUN','cleanupGate':'PASS','restoreGate':'PASS','applicationSourceUnchangedDuringVerification':True,'fullQa09Accepted':False,'p95Accepted':False};(out/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
