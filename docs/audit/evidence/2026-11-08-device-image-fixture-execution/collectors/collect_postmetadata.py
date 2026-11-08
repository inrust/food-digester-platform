"""Final metadata reads only: inspect test functions and confirm existing project defaults unchanged."""
import hashlib,json,os,subprocess
from pathlib import Path
BASE=Path(__file__).resolve().parents[1]
ROOT=Path(__file__).resolve().parents[5]
PREP=ROOT/'docs/audit/evidence/2026-11-08-device-image-fixture-preparation'


def read(args,query):
    assert tuple(args[:2]) in {('lambda','list-functions'),('codebuild','batch-get-projects')}
    p=subprocess.run(['aws',*args,'--profile','esgiot-readonly','--region','ap-southeast-1',
        '--output','json','--no-cli-pager','--cli-connect-timeout','5','--cli-read-timeout','15','--query',query],
        capture_output=True,text=True,timeout=30,env={**os.environ,'AWS_MAX_ATTEMPTS':'1','AWS_PAGER':''})
    if p.returncode:raise RuntimeError('FINAL_READ_FAILED')
    return json.loads(p.stdout)


functions=read(['lambda','list-functions'],"Functions[?starts_with(FunctionName, 'fdp-test-')].{name:FunctionName,codeSha256:CodeSha256,role:Role}")
project=read(['codebuild','batch-get-projects','--names','fdp-test-qa09-readonly-runner'],
    'projects[0].{name:name,serviceRole:serviceRole,vpc:vpcConfig,sourceType:source.type,buildspec:source.buildspec}')
actual=hashlib.sha256(json.dumps(json.loads(project.pop('buildspec')),sort_keys=True,separators=(',',':')).encode()).hexdigest()
initial=json.loads((PREP/'readonly-job-binding.json').read_text())
previous=json.loads((BASE/'current-readonly-observations.json').read_text())['projects']['data']['projects']
expected=next(v for v in previous if v['name']==project['name'])
unchanged=actual==initial['actualBuildspecSha256'] and project['serviceRole']==expected['serviceRole'] and project['vpc']==expected['vpc'] and project['sourceType']==expected['sourceType']
known={v['name'] for v in json.loads((BASE/'current-readonly-observations.json').read_text())['functions']}
result={'status':'PASS_PROJECT_DEFAULTS_UNCHANGED' if unchanged else 'BLOCKED_PROJECT_DEFAULTS_DRIFT',
    'project':project,'defaultBuildspecSha256':actual,'matchesBeforeApprovedOverride':unchanged,
    'testFunctions':functions,'additionalFunctionsBeyondReviewedApplicationInventory':[v['name'] for v in functions if v['name'] not in known],
    'cloudWrites':0,'noProjectUpdateCalled':True}
(BASE/'postflight-metadata.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'status':result['status'],'testFunctionCount':len(functions),'additionalFunctions':result['additionalFunctionsBeyondReviewedApplicationInventory']}))
