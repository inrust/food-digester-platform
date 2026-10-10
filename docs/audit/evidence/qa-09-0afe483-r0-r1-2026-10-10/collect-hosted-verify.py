"""Read successful same-SHA hosted verification, persist only count/gate lines."""
import subprocess,json,sys,re,hashlib,datetime
from pathlib import Path
root=Path(__file__).parent;mode,run=sys.argv[1:];p=root/mode;sha='0afe48384537c8c79ec6ce87276858120b9fd6ef'
r=subprocess.run(['gh','run','view',run,'--json','headSha,status,conclusion,event,jobs,url'],capture_output=True,text=True,timeout=180);assert r.returncode==0;r=json.loads(r.stdout);assert r['headSha']==sha and r['conclusion']=='success' and r['status']=='completed'
verify=[s for j in r['jobs'] for s in j['steps'] if s['name']=='Run pnpm verify'];assert len(verify)==1 and verify[0]['conclusion']=='success'
l=subprocess.run(['gh','run','view',run,'--log'],capture_output=True,text=True,timeout=180);assert l.returncode==0
start=datetime.datetime.fromisoformat(verify[0]['startedAt'].replace('Z','+00:00'));end=datetime.datetime.fromisoformat(verify[0]['completedAt'].replace('Z','+00:00'))
lines=[]
for line in l.stdout.splitlines():
 fields=line.split('\t',2)
 if len(fields)!=3:continue
 match=re.match(r'(\S+) ',fields[2])
 if not match:continue
 try:at=datetime.datetime.fromisoformat(match[1].replace('Z','+00:00'))
 except ValueError:continue
 clean=re.sub(r'(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]','',line)
 if start<=at<end and re.search(r'(Test Files\s+\d+ passed|Tests\s+\d+ passed|\d+ passed \(|ℹ (tests|pass|fail) \d+|"status": "PASS")',clean):lines.append(clean)
assert lines,'HOSTED_COUNT_LINES_REQUIRED'
(p/('hosted-verify-'+run+'.json')).write_text(json.dumps({'gate':'PASS','scope':'HOSTED_SAME_SHA_VERIFY_STEP_AND_SELECTED_COUNTS','sourceCommit':sha,'runId':run,'url':r['url'],'step':verify[0],'selectedCountLines':lines,'rawLogSha256':hashlib.sha256(l.stdout.encode()).hexdigest(),'rawLogPersisted':False},indent=2)+'\n');print('hosted verify counts PASS',len(lines))
