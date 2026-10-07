import subprocess,hashlib,json,re,sys
from pathlib import Path
root=Path(__file__).parent
mode,run=sys.argv[1:];assert mode in ['off','on'] and run.isdigit()
q=subprocess.run(['gh','run','view',run,'--log'],capture_output=True,text=True,timeout=180)
assert q.returncode==0,'DEPLOY_LOG_READ_FAILED'
lines=[line for line in q.stdout.splitlines() if '\tRun node scripts/esgiot-cdk.mjs diff AppDependencies\t' in line]
changes=[]
for line in lines:
 m=re.search(r'\[([~+\-])\] (AWS::[A-Za-z0-9]+::[A-Za-z0-9]+) ([A-Za-z0-9_/-]+)',line)
 if m:changes.append({'change':m.group(1),'resourceType':m.group(2),'resourceName':m.group(3)})
assert changes and all(c['resourceType']=='AWS::Lambda::Function' and c['resourceName']=='ApiFn' for c in changes),'UNEXPECTED_CDK_RESOURCE_DIFF'
flags=[]
for line in lines:
 flags += re.findall(r'"FDP_QA09_ENGINE_CPU_DIAGNOSIS": "(true|false)"',line)
result={'gate':'PASS','scope':'ACTUAL_SUCCESSFUL_MANUAL_RUN_CDK_DIFF_SAFE_RESOURCE_SUMMARY','runId':run,'changedResources':changes,'engineFlagValuesInDiff':flags,'rawLogSha256':hashlib.sha256(q.stdout.encode()).hexdigest(),'rawLogPersisted':False,'iamKmsCapacityResourceDiff':False,'p95Accepted':False}
(root/mode/'cdk-diff-summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
