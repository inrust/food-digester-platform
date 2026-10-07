import subprocess,hashlib,json,re,sys
from pathlib import Path
root=Path(__file__).parent
mode,run=sys.argv[1:];assert mode in ['c0','c1','restore'] and run.isdigit()
q=subprocess.run(['gh','run','view',run,'--log'],capture_output=True,text=True,timeout=180)
assert q.returncode==0,'DEPLOY_LOG_READ_FAILED'
lines=[line for line in q.stdout.splitlines() if '\tRun node scripts/esgiot-cdk.mjs diff AppDependencies\t' in line]
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
result={'gate':'PASS','scope':'ACTUAL_SUCCESSFUL_MANUAL_RUN_CDK_DIFF_SAFE_RESOURCE_SUMMARY','runId':run,'changedResources':changes,'engineFlagValuesInDiff':flags,'preconnectFlagValuesInDiff':preconnect,'rawLogSha256':hashlib.sha256(q.stdout.encode()).hexdigest(),'rawLogPersisted':False,'iamKmsCapacityResourceDiff':False,'p95Accepted':False}
(root/mode/'cdk-diff-summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
