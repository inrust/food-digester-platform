import subprocess,hashlib,json,re,sys,datetime
from pathlib import Path
root=Path(__file__).parent
mode,run=sys.argv[1:3];output=sys.argv[3] if len(sys.argv)>3 else 'cdk-diff-summary.json';assert Path(output).name==output;assert mode in ['r0','r1','restore'] and run.isdigit()
q=subprocess.run(['gh','run','view',run,'--log'],capture_output=True,text=True,timeout=180)
assert q.returncode==0,'DEPLOY_LOG_READ_FAILED'
r=json.loads(subprocess.check_output(['gh','run','view',run,'--json','headSha,status,conclusion,jobs'],text=True));assert r['headSha']=='b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e' and r['conclusion']=='success' and r['status']=='completed'
steps=[(j,s) for j in r['jobs'] for s in j['steps'] if s['name']=='Run node scripts/esgiot-cdk.mjs diff AppDependencies'];assert len(steps)==1 and steps[0][1]['conclusion']=='success'
job,step=steps[0];start=datetime.datetime.fromisoformat(step['startedAt'].replace('Z','+00:00'));end=datetime.datetime.fromisoformat(step['completedAt'].replace('Z','+00:00'));lines=[]
for line in q.stdout.splitlines():
 fields=line.split('\t',2)
 if len(fields)!=3 or fields[0]!=job['name']:continue
 match=re.match(r'(\S+) ',fields[2].lstrip('\ufeff'))
 if not match:continue
 try:at=datetime.datetime.fromisoformat(match[1].replace('Z','+00:00'))
 except ValueError:continue
 if fields[1]==step['name'] or (fields[1]=='UNKNOWN STEP' and start<=at<end+datetime.timedelta(seconds=1)):lines.append(re.sub(r'(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]','',line))
assert lines,'DIFF_STEP_LOG_REQUIRED'
changes=[]
for line in lines:
 m=re.search(r'\[([~+\-])\] (AWS::[A-Za-z0-9]+::[A-Za-z0-9]+) ([A-Za-z0-9_/-]+)',line)
 if m:changes.append({'change':m.group(1),'resourceType':m.group(2),'resourceName':m.group(3)})
assert all(c['resourceType']=='AWS::Lambda::Function' and c['resourceName']=='ApiFn' for c in changes),'UNEXPECTED_CDK_RESOURCE_DIFF'
flags=[]
preconnect=[]
for line in lines:
 preconnect += re.findall(r'"FDP_QA09_AUTHENTICATED_PRECONNECT": "(true|false)"',line)
 flags += re.findall(r'"FDP_QA09_ENGINE_CPU_DIAGNOSIS": "(true|false)"',line)
result={'gate':'PASS','scope':'ACTUAL_SUCCESSFUL_MANUAL_RUN_CDK_DIFF_SAFE_RESOURCE_SUMMARY','runId':run,'changedResources':changes,'engineFlagValuesInDiff':flags,'preconnectFlagValuesInDiff':preconnect,'rawLogSha256':hashlib.sha256(q.stdout.encode()).hexdigest(),'rawLogPersisted':False,'selectionMethod':'SUCCESSFUL_NAMED_STEP_OR_UNKNOWN_STEP_JOB_TIMESTAMP_WITH_SECOND_PRECISION_END','step':step,'iamKmsCapacityResourceDiff':False,'p95Accepted':False}
(root/mode/output).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
