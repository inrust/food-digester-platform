"""Local completed-pair evidence validation only; never calls AWS or business APIs."""
from pathlib import Path
import ast, base64, gzip, hashlib, json, re, subprocess

root = Path(__file__).resolve().parent
sha = 'be97cb60d356c6b86eea85455e2087ff54d0bb5a'
out = root / 'local-hygiene-check.json'
assert not out.exists()
patterns = [re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'), re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'), re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
counts = dict(files=0, pythonAst=0, nodeSyntax=0, decodedSources=0, gzipSources=0)
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def read(n): return json.loads((root / n).read_text())
def scan(b): assert not any(p.search(b) for p in patterns), 'CREDENTIAL_PATTERN_DETECTED'
def walk(v):
    if isinstance(v, dict):
        for k, x in v.items():
            if k == 'sourceBase64' and isinstance(x, str):
                scan(base64.b64decode(x, validate=True)); counts['decodedSources'] += 1
            if k == 'buildspec' and isinstance(x, str):
                for token in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}', x):
                    b = base64.b64decode(token, validate=True); scan(b)
                    if b.startswith(b'\x1f\x8b'):
                        b = gzip.decompress(b); assert len(b) < 2 * 1024 * 1024
                        scan(b); counts['gzipSources'] += 1
            walk(x)
    elif isinstance(v, list):
        for x in v: walk(x)
for p in sorted(root.rglob('*')):
    if not p.is_file(): continue
    counts['files'] += 1; b = p.read_bytes(); scan(b)
    if p.suffix == '.py': ast.parse(b, filename=str(p)); counts['pythonAst'] += 1
    if p.suffix == '.mjs':
        q = subprocess.run(['node', '--check', str(p)], capture_output=True)
        assert q.returncode == 0, str(p)
        counts['nodeSyntax'] += 1
    if p.suffix == '.json': walk(json.loads(b))

entry=read('preflight/entry-completion.json');assert entry['gate']=='PASS'
for n,h in entry['bindings'].items():assert digest(root/n)==h
for n,h in read('preflight/entry-scope.json')['entryHelpers'].items():assert digest(root/n)==h
for n,h in read('preflight/helper-input-check.json')['repositoryDependencies'].items():assert digest(Path(n))==h
v=read('preflight/predeployment-failure-closure.json');assert v['gate']=='PASS' and v['r0StageGate']=='FAIL' and v['restore']=='NOT_REQUIRED' and v['businessFixtures']==0
for n,h in v['bindings'].items():assert digest(root/n)==h
v=read('preflight/failure-runtime19-comparison.json');assert v['gate']=='PASS' and v['count']==19
for n,h in v['bindings'].items():assert digest(root/n)==h
assert not any((root/m/'sample.json').exists() for m in ['r0','r1'])
q=subprocess.run(['python3',str(root/'check-implementation-seal.py')],capture_output=True,text=True);assert q.returncode==0
hist=json.loads(q.stdout);assert hist['sealedFiles']==937
out.write_text(json.dumps({'gate':'PASS','scope':'LOCAL_ORIGINAL_FAILED_PREDEPLOYMENT_ENTRY_BYTES_RUNTIME_UNCHANGED_AND_HYGIENE_ONLY','sourceCommit':sha,'counts':counts,'historicalFilesVerified':937,'r0StageGate':'FAIL','r1':'NOT_RUN','restore':'NOT_REQUIRED','businessFixtures':0,'p95Accepted':False,'fullQa09Accepted':False},indent=2)+'\n');print(out.read_text())
