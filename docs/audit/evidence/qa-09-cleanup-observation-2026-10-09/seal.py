import base64,datetime,hashlib,json,re,subprocess
from pathlib import Path
root=Path(__file__).parent
assert not (root/'manifest.json').exists()
sourceNames=['qa09-operation-observation.mjs','qa09-started-build-read.mjs','qa09-ten-device-bridge.mjs','qa09-db-frame-wait.mjs','qa09-db-frame-wait.test.mjs','qa09-business-target.mjs','run-qa09-ten-device-acceptance.mjs','recover-qa09-db-result.mjs','qa09-cleanup-recovery.test.mjs','qa09-fixture-cli-observation.test.mjs']
sha=lambda b:hashlib.sha256(b).hexdigest()
read=json.loads((root/'existing-build-readonly-final.json').read_text())
assert read['gate']=='PASS' and read['writes']==0 and read['originalGate']=='RUNNING'
assert read['build']['id']=='fdp-test-qa09-ten-device-fixtures:deb278e5-c58b-4d8f-aa35-506d2889f7a5'
assert read['build']['status']=='SUCCEEDED' and read['result']['action']=='business-cleanup' and all(v==0 for v in read['result']['counts'].values())
assert sha(Path(read['recoveredFrom']).read_bytes())==read['recoveredFromSha256']
assert sha(Path(read['recoveredFrom']+'.preparation.json').read_bytes())==read['preparationSha256']
for s in read['dependencySources']:
 assert sha(Path('scripts',s['name']).read_bytes())==s['sha256']
 assert sha(base64.b64decode(s['sourceBase64'],validate=True))==s['sha256']
assert sha(Path('scripts/recover-qa09-db-result.mjs').read_bytes())==read['recoverySourceHash']
for name in ['device-contracts','iot-integration','core-api-integration','admin-e2e','security','reliability','prototype-regression']:
 assert json.loads((root/('local-'+name+'-gate.json')).read_text())['status']=='PASS'
assert 'ℹ tests 733' in (root/'final-script-tests.log').read_text() and 'ℹ fail 0' in (root/'final-script-tests.log').read_text()
assert 'ℹ tests 17' in (root/'targeted-tests-final.log').read_text() and 'ℹ fail 0' in (root/'targeted-tests-final.log').read_text()
assert 'ℹ tests 732' in (root/'verify-fixed.log').read_text() and 'ℹ fail 0' in (root/'verify-fixed.log').read_text()
assert 'test:prototype-regression' in (root/'verify-fixed.log').read_text()
assert 'All matched files use Prettier code style!' in (root/'final-format.log').read_text()
q=subprocess.run(['git','diff','--check'],capture_output=True);assert q.returncode==0
q=subprocess.run(['git','diff','--','apps','packages','infra','contracts','.github','package.json','pnpm-lock.yaml'],capture_output=True);assert q.returncode==0 and not q.stdout
old=Path('docs/audit/evidence/qa-09-b41b45c-r0-r1-2026-10-09');historic=json.loads((old/'manifest.json').read_text())
for n,h in historic['files'].items(): assert sha((old/n).read_bytes())==h,n
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
blocks=0
def scan(b): assert not any(p.search(b) for p in patterns),'SECRET_PATTERN'
def visit(v):
 global blocks
 if isinstance(v,dict):
  for k,x in v.items():
   if k in ['sourceBase64','recoverySourceBase64'] and isinstance(x,str):scan(base64.b64decode(x,validate=True));blocks+=1
   visit(x)
 elif isinstance(v,list):
  for x in v:visit(x)
for p in root.rglob('*'):
 if p.is_file():
  scan(p.read_bytes())
  if p.suffix=='.json': visit(json.loads(p.read_text()))
summary={'gate':'PASS','scope':'LOCAL_CLEANUP_OBSERVATION_AND_EXACT_EXISTING_BUILD_READ_ONLY_RECOVERY','commands':{'initialPnpmVerify':1,'fixedPnpmVerify':0,'finalPnpmScriptTests':0,'finalTargetedTests':0,'finalLint':0,'finalFormat':0},'applicationTests':1497,'contractTests':302,'completeVerifyScriptTests':732,'finalScriptTests':733,'finalTargetedTests':17,'localQa02To08Gates':'PASS','existingBuildReadOnlyRecovery':'PASS','awsWrites':0,'newBusinessFixtures':0,'historicEvidenceHashesUnchanged':len(historic['files']),'decodedSourcesScanned':blocks,'secretPatternHits':0,'newShaCiDeploy19Artifacts':'NOT_RUN','newPrefixR0R1Restore':'NOT_RUN','fullQa09Accepted':False,'p95Accepted':False}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
bindings={str(p.relative_to(root)):sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['manifest.json','seal.stdout.log','seal.stderr.log']}
manifest={'gate':'PARTIAL','localImplementationGate':'PASS','targetGate':'NOT_RUN','sourceCommit':None,'implementationSourceHashes':{'scripts/'+n:sha(Path('scripts',n).read_bytes()) for n in sourceNames},'fileCount':len(bindings),'files':bindings,'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fullQa09Accepted':False,'p95Accepted':False}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(summary))
