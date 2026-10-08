"""Read-only credential hygiene over raw files and every decodable long JSON base64 string."""
import pathlib,json,re,base64,hashlib,sys
root=pathlib.Path(__file__).parent.parent;output=root/sys.argv[1];assert not output.exists()
patterns=[re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),re.compile(rb'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----')]
counts={'rawFiles':0,'jsonFiles':0,'decodedBase64Strings':0};bindings={}
def safe(b,path):assert not any(p.search(b) for p in patterns),'CREDENTIAL_PATTERN_DETECTED:'+str(path)
def walk(v,path):
 if isinstance(v,dict):
  for x in v.values():walk(x,path)
 elif isinstance(v,list):
  for x in v:walk(x,path)
 elif isinstance(v,str):
  for token in re.findall(r'[A-Za-z0-9+/]{120,}={0,2}',v):
   try:b=base64.b64decode(token,validate=True)
   except ValueError:continue
   safe(b,path);counts['decodedBase64Strings']+=1
for p in sorted(root.rglob('*')):
 if not p.is_file():continue
 b=p.read_bytes();safe(b,p);counts['rawFiles']+=1;bindings[str(p.relative_to(root))]=hashlib.sha256(b).hexdigest()
 if p.suffix=='.json':counts['jsonFiles']+=1;walk(json.loads(b),p)
output.write_text(json.dumps({'gate':'PASS','scope':'RAW_AND_ALL_JSON_LONG_BASE64_CREDENTIAL_PATTERN_HYGIENE_ONLY','sourceCommit':'17fb6f10443f74d05ae3686928b9f2ed575d9b05','counts':counts,'credentialPatternHits':0,'bindings':bindings},indent=2)+'\n');print(json.dumps({'gate':'PASS','counts':counts,'credentialPatternHits':0}))
