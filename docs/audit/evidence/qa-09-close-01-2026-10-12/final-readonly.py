"""Independent bounded read of only this task's Cognito prefixes and known Build IDs."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parent
output = ROOT / 'final-readonly.json'
assert not output.exists()
load = lambda n: json.loads((ROOT/n).read_bytes())
run = load('user-target-v2.json')
assert run['gate'] == 'PASS_SCOPED_FIVE_ROLE_SIGNED_SESSION_AND_USER_WRITES'
result = {'scope':'READ_ONLY_OWN_PREFIX_IDENTITIES_AND_EXACT_BUILD_TERMINALS','gate':'RUNNING','writes':0,'originalUnknownStart':'UNKNOWN_NO_RESTART','requests':[]}
def aws(args):
    p = subprocess.run(['aws',*args,'--profile','esgiot-infra','--region','ap-southeast-1','--output','json'],capture_output=True,timeout=25)
    result['requests'].append({'service':args[0],'operation':args[1],'exitCode':p.returncode})
    assert p.returncode == 0, 'READ_ONLY_AWS_UNAVAILABLE'
    return json.loads(p.stdout)
try:
    identity = aws(['sts','get-caller-identity'])
    assert identity['Account']=='065986019555' and ':assumed-role/AWSReservedSSO_FDP-InfraSetup_' in identity['Arn']
    result['accountId'] = identity['Account']
    result['identities'] = []
    for filename in ['user-target.json','user-target-v2.json']:
        own=load(filename)
        assert own['prefix'].startswith('qa09-')
        rows=aws(['cognito-idp','list-users','--user-pool-id','ap-southeast-1_hZMX8LpFo','--filter','email ^= "'+own['prefix']+'-"','--query','Users[].{username:Username,createdAt:UserCreateDate}'])
        result['identities'].append({'prefix':own['prefix'],'count':len(rows)})
        assert not rows, 'OWN_COGNITO_NOT_EMPTY'
    ids=[b['buildId']for b in run['fixtureBuilds']]
    rows=aws(['codebuild','batch-get-builds','--ids',*ids,'--query','builds[].{id:id,status:buildStatus,endTime:endTime}'])
    result['builds']=rows
    assert {b['id']for b in rows}==set(ids) and all(b['status']=='SUCCEEDED'for b in rows)
    result['userTargetSha256']=hashlib.sha256((ROOT/'user-target-v2.json').read_bytes()).hexdigest()
    result['gate']='PASS_READ_ONLY_IDENTITIES_EMPTY_BUILDS_TERMINAL'
finally:
    result['checkedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False))
