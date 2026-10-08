"""Seal local detailed-boundary implementation evidence; no cloud/push operations."""
import ast, base64, hashlib, json, re, subprocess
from pathlib import Path
r = Path(__file__).parent
load = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for name in ['core-integrated','scripts-final','infra-focused','historical-negative','full-verify','flag-inheritance-final','flagged-full-verify']:
    assert (r/(name+'.exit')).read_text().strip() == '0', name
for p in (r/'local-gates').glob('*.json'):
    value=load(p); assert value.get('status',value.get('gate'))=='PASS', str(p)
assert len(list((r/'local-gates').glob('*.json')))==7
assert load(r/'historical-negative.json')['newTargetGate']=='NOT_RUN'
for row in load(r/'historical-integrity.json')['checks']:
    root=Path(row['root'])
    for f,h in load(root/'manifest.json')['files'].items(): assert sha(root/f)==h
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
files=sorted(p for p in r.rglob('*') if p.is_file())
decoded=[0]
def scan_strings(v, name):
    if isinstance(v,dict):
        for x in v.values(): scan_strings(x,name)
    elif isinstance(v,list):
        for x in v: scan_strings(x,name)
    elif isinstance(v,str) and len(v)>=120 and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}',v):
        try: b=base64.b64decode(v,validate=True)
        except ValueError: return
        decoded[0]+=1; assert not any(p.search(b) for p in patterns),name
for p in files:
    b=p.read_bytes(); assert not any(pattern.search(b) for pattern in patterns),str(p)
    if p.suffix=='.py': ast.parse(b)
    if p.suffix=='.json': scan_strings(load(p),str(p))
subprocess.run(['git','diff','--check'],check=True)
paths=load(r/'changed-files.json')['implementationAndDocumentation']
manifest={
    'gate':'PASS','scope':'DEFAULT_OFF_WIRING_LOCAL_VALIDATION_ONLY',
    'baselineCommit':'3554c1e4113594a584dd1156f97cd532875b5604',
    'newSourceBoundBy':'SOURCE_SHA256_AND_LOCAL_COMMIT_NOT_HOSTED_SAME_SHA_RECEIPT',
    'runtimeAndDeploymentChanged':True,'cloudOperationsPerformed':False,
    'newTargetCiDeploy19Artifacts':'NOT_RUN','naturalColdPair':'NOT_RUN','targetCleanupRestore':'NOT_RUN',
    'verificationEnvironment':'ALL_FOUR_MANUAL_CANDIDATE_FLAGS_TRUE_WITH_BASELINE_FIXTURE_ISOLATION',
    'defaultEnvironmentInitialApplicationTests':1495,
    'localTests':{'application':1497,'contracts':302,'scripts':719,'browserE2E':36,'localGateCount':7},
    'credentialPatternHits':0,'decodedBase64':decoded[0],
    'compilerOnlyAttribution':False,'serverExecutionIsolated':False,'p95Accepted':False,'fullQa09Accepted':False,
    'sourceFiles':{p:sha(Path(p)) for p in paths},
    'files':{str(p.relative_to(r)):sha(p) for p in files if p.name not in ['manifest.json','finalize.stdout.log','finalize.stderr.log','finalize.exit']}
}
assert not (r/'manifest.json').exists()
(r/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'gate':manifest['gate'],'scope':manifest['scope'],'sealedFiles':len(manifest['files']),'sourceFiles':len(paths),'newTargetGate':'NOT_RUN','credentialPatternHits':0,'decodedBase64':decoded[0]}))
