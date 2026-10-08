"""Seal CI diagnosis and clean-build regression evidence; no external operations."""
import ast, base64, hashlib, json, re, subprocess
from pathlib import Path
r=Path(__file__).parent
sha=lambda b:hashlib.sha256(b).hexdigest()
load=lambda p:json.loads(p.read_text())
for name in ['clean-self-final','clean-workspace-typecheck','targeted-tests','lint','format']:
 assert (r/(name+'.exit')).read_text().strip()=='0',name
assert (r/'clean-self-initial.exit').read_text().strip()=='2'
assert "Cannot find module '@fdp/database'" in (r/'clean-self-initial.log').read_text()
assert load(r/'clean-workspace-typecheck.json')['originalBuildOutputsRestored'] is True
for name in ['ci-run','deploy-run']:
 v=load(r/(name+'.json'));assert v['headSha']=='29b1b93455fa9f68675f4b473f31d4994e1eb774' and v['conclusion']=='failure'
# Prior sealed files stay immutable; historical source bindings are checked against their original commit.
old=r.parent/'qa-09-contract-detail-wiring-2026-10-08';m=load(old/'manifest.json')
for p,h in m['files'].items():assert sha((old/p).read_bytes())==h,p
for p,h in m['sourceFiles'].items():
 b=subprocess.run(['git','show','29b1b93455fa9f68675f4b473f31d4994e1eb774:'+p],check=True,capture_output=True).stdout
 assert sha(b)==h,p
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
files=sorted(p for p in r.rglob('*') if p.is_file());decoded=[0]
def walk(v,name):
 if isinstance(v,dict):
  for x in v.values():walk(x,name)
 elif isinstance(v,list):
  for x in v:walk(x,name)
 elif isinstance(v,str) and len(v)>=120 and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}',v):
  try:b=base64.b64decode(v,validate=True)
  except ValueError:return
  decoded[0]+=1;assert not any(p.search(b) for p in patterns),name
for p in files:
 b=p.read_bytes();assert not any(pattern.search(b) for pattern in patterns),str(p)
 if p.suffix=='.json':walk(load(p),str(p))
 if p.suffix=='.py':ast.parse(b)
subprocess.run(['git','diff','--check'],check=True)
unchanged=subprocess.run(['git','diff','29b1b93455fa9f68675f4b473f31d4994e1eb774','--',':(glob)apps/*/src/**',':(glob)packages/*/src/**','infra','.github','package.json','pnpm-lock.yaml','packages/database/tsconfig.build.json','packages/database/package.json'],check=True,capture_output=True).stdout
assert not unchanged,'RUNTIME_OR_DEPLOYMENT_DRIFT'
paths=['packages/database/tsconfig.json','docs/audit/QA-09-29b1b93干净CI类型解析修复-2026-10-08.md','docs/管理后台开发任务清单.md']
manifest={'gate':'PASS','scope':'CLEAN_LOCAL_TYPECHECK_CI_FIX_ONLY','baselineCommit':'29b1b93455fa9f68675f4b473f31d4994e1eb774','ciFailureRun':37785509251,'deployFailureRun':37785509323,'cleanTypecheckTasks':21,'cacheHits':0,'targetedTests':36,'runtimeUnchanged':True,'productionExportsUnchanged':True,'deploymentUnchanged':True,'cloudOperationsPerformed':False,'hostedNewShaGate':'NOT_RUN','targetNaturalColdPair':'NOT_RUN','qa09Gate':'PARTIAL','p95Accepted':False,'fullQa09Accepted':False,'credentialPatternHits':0,'decodedBase64':decoded[0],'historicalSealedFilesChecked':len(m['files']),'historicalSourceGitBlobsChecked':len(m['sourceFiles']),'sourceFiles':{p:sha(Path(p).read_bytes()) for p in paths},'files':{str(p.relative_to(r)):sha(p.read_bytes()) for p in files if p.name not in ['manifest.json','finalize.stdout.log','finalize.stderr.log','finalize.exit']}}
assert not (r/'manifest.json').exists();(r/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k not in ['files','sourceFiles']}))
