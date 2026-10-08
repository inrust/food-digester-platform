"""Validate and seal local controls/transport evidence. No external operations."""
import ast,base64,hashlib,json,re,subprocess
from pathlib import Path
r=Path(__file__).parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
load=lambda p:json.loads(p.read_text())
for n in ['matrix-final','validator-final','typecheck-final','lint','node-transport','curl-transport','summary','full-verify']:
 assert (r/(n+'.exit')).read_text().strip()=='0',n
summary=load(r/'summary.json');assert summary['gate']=='PASS'
for b in summary['bindings'].values():assert sha(Path(b['path']))==b['sha256']
matrix=load(r/'matrix-final/matrix.json')
for item in matrix['inputs']:assert sha(Path(item['path']))==item['sha256']
for b in load(r/'environment.json')['libraries']:assert sha(Path(b['path']))==b['sha256']
q=subprocess.run(['git','diff','3cb5b759caeb38cc7c54a0506174be7832cc6f2e','--',':(glob)apps/*/src/**',':(glob)packages/*/src/**','infra','.github','package.json','pnpm-lock.yaml'],capture_output=True,check=True)
assert not q.stdout,'RUNTIME_OR_DEPLOYMENT_DRIFT'
q=subprocess.run(['git','diff','--check'],capture_output=True,check=True);assert not q.stdout
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
files=sorted(p for p in r.rglob('*') if p.is_file());decoded=0
for p in files:
 b=p.read_bytes();assert not any(x.search(b) for x in patterns),str(p)
 if p.suffix=='.py':ast.parse(b)
 if p.suffix=='.json':
  def walk(v):
   global decoded
   if isinstance(v,dict):
    for x in v.values():walk(x)
   elif isinstance(v,list):
    for x in v:walk(x)
   elif isinstance(v,str) and len(v)>=120 and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}',v):
    try:b=base64.b64decode(v,validate=True)
    except ValueError:return
    decoded+=1;assert not any(x.search(b) for x in patterns),str(p)
  walk(load(p))
paths=['packages/database/test/contract-load-offline.test.ts','scripts/run-qa09-contract-load-offline.mjs','scripts/qa09-contract-load-offline.test.mjs','scripts/qa09-contract-load-proof.d.mts']
result={'gate':'PASS','scope':'OFFLINE_CONTROLS_AND_NORMAL_TLS_INDEPENDENT_READS_ONLY','filesScanned':len(files),'decodedBase64':decoded,'credentialPatternHits':0,'runtimeSourceUnchanged':True,'deploymentUnchanged':True,'originalTargetSubwindows':'NOT_RUN','compilerOnlyAttribution':False,'serverExecutionIsolated':False,'p95Accepted':False,'fullQa09Accepted':False,'sourceFiles':{p:sha(Path(p)) for p in paths},'files':{str(p.relative_to(r)):sha(p) for p in files if p.name not in ['manifest.json','finalize.stdout.log','finalize.stderr.log','finalize.exit']}}
assert not (r/'manifest.json').exists();(r/'manifest.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['files','sourceFiles']}))
