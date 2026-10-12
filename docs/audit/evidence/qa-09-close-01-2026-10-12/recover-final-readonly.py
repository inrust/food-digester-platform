"""Finish only the failed read component; never repeats a mutation or Build start."""
from pathlib import Path
import datetime,hashlib,json,subprocess,time
ROOT=Path(__file__).resolve().parent
out=ROOT/'final-readonly-recovered.json'
assert not out.exists()
raw=(ROOT/'final-readonly.json').read_bytes(); prior=json.loads(raw)
run=json.loads((ROOT/'user-target-v2.json').read_bytes())
assert prior['writes']==0 and prior['accountId']=='065986019555' and len(prior['identities'])==2 and all(x['count']==0 for x in prior['identities'])
ids=[b['buildId']for b in run['fixtureBuilds']]
r={'scope':'READ_ONLY_COMPONENT_RECOVERY_NO_BUILD_START','gate':'RUNNING','originalReadGate':'FAIL','originalReceiptSha256':hashlib.sha256(raw).hexdigest(),'identitiesReadAt':prior['checkedAt'],'identities':prior['identities'],'writes':0,'originalUnknownStart':'UNKNOWN_NO_RESTART','observations':[],'builds':[]}
save=lambda:out.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
deadline=time.monotonic()+90
try:
    for i in range(0,len(ids),2):
        for attempt in range(1,3):
            remaining=deadline-time.monotonic()
            assert remaining>1,'READ_BUDGET_EXHAUSTED'
            row={'operation':'batch-get-builds','ids':ids[i:i+2],'attempt':attempt,'result':'RUNNING'};r['observations'].append(row);save()
            try:
                p=subprocess.run(['aws','codebuild','batch-get-builds','--ids',*row['ids'],'--query','builds[].{id:id,status:buildStatus,endTime:endTime}','--profile','esgiot-infra','--region','ap-southeast-1','--output','json'],capture_output=True,timeout=min(20,remaining))
                assert p.returncode==0,'READ_FAILED'
                values=json.loads(p.stdout)
                assert {b['id']for b in values}==set(row['ids']) and all(b['status']=='SUCCEEDED'for b in values),'BUILD_NOT_TERMINAL'
                r['builds'].extend(values);row['result']='PASS';save();break
            except subprocess.TimeoutExpired:
                row['result']='TIMEOUT';save()
                if attempt==2:raise
    assert {b['id']for b in r['builds']}==set(ids)
    r['userTargetSha256']=hashlib.sha256((ROOT/'user-target-v2.json').read_bytes()).hexdigest()
    r['gate']='PASS_READ_ONLY_IDENTITIES_EMPTY_BUILDS_TERMINAL'
except Exception as e:
    r['gate']='FAIL';r['errorType']=type(e).__name__;raise
finally:
    r['checkedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
print(json.dumps({'gate':r['gate'],'builds':len(r['builds']),'writes':0}))
