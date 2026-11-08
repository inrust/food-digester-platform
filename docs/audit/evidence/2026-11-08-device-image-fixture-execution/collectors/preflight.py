"""Only preflight reads; approved mutations are performed separately after a window is recorded."""
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
BASE = Path(__file__).resolve().parents[1]
PREP = ROOT/'docs/audit/evidence/2026-11-08-device-image-fixture-preparation'


def dump(name, value):
    (BASE/name).write_text(json.dumps(value, indent=2)+'\n')


def aws(args, profile='esgiot-readonly', query=None):
    assert tuple(args[:2]) in {('sts','get-caller-identity'),('lambda','list-functions'),
        ('codebuild','list-projects'),('cognito-idp','admin-get-user'),('iam','get-role')}
    cmd=['aws',*args,'--profile',profile,'--region','ap-southeast-1','--output','json','--no-cli-pager',
        '--cli-connect-timeout','5','--cli-read-timeout','15']
    if query:cmd+=['--query',query]
    try:
        p=subprocess.run(cmd,capture_output=True,text=True,timeout=30,env={**os.environ,'AWS_MAX_ATTEMPTS':'1','AWS_PAGER':''})
        if p.returncode:
            category=next((c for c in ['UserNotFoundException','AccessDeniedException','AccessDenied','ExpiredToken','NoSuchEntity'] if c in p.stderr),'READ_UNAVAILABLE')
            return {'status':'ABSENT' if category=='UserNotFoundException' else 'BLOCKED','errorCategory':category}
        return {'status':'OBSERVED','data':json.loads(p.stdout)}
    except subprocess.TimeoutExpired:return {'status':'BLOCKED','errorCategory':'READ_TIMEOUT'}


def main():
    identity=json.loads((PREP/'local-identity.json').read_text())
    keydir=Path(identity['privateDirectory']); key=keydir/'device-key.pem'
    assert stat.S_IMODE(keydir.stat().st_mode)==0o700 and stat.S_IMODE(key.stat().st_mode)==0o600
    csr=PREP/'device.csr.pem'
    assert hashlib.sha256(csr.read_bytes()).hexdigest()==identity['csrSha256']
    assert subprocess.run(['openssl','req','-in',str(csr),'-verify','-noout'],capture_output=True).returncode==0
    pub=subprocess.run(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'],capture_output=True,check=True).stdout
    assert hashlib.sha256(pub).hexdigest()==identity['publicKeySha256']
    approval=json.loads((PREP/'write-approval-request.json').read_text())
    req=PREP/'readonly-db-start.request.json'
    w6=next(v for v in approval['requestedWrites'] if v['id']=='W06')
    assert hashlib.sha256(req.read_bytes()).hexdigest()==w6['requestSha256']
    script=PREP/'collectors/collect_readonly.py'
    spec=importlib.util.spec_from_file_location('metadata',script);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    obs=module.collect();dump('current-readonly-observations.json',obs)
    assert obs['status']=='OBSERVED_READONLY_METADATA' and len(obs['functions'])==20
    assert all(v['matchesHistoricalCode'] and v['data']['state']=='Active' and v['data']['lastUpdateStatus']=='Successful' for v in obs['functions'])
    assert all(v['data']['control']=='fdp-test-live-image-control' and v['data']['payload']=='fdp-test-live-image-payload' for v in obs['functions'] if v['name']!='fdp-test-archive')
    operator=aws(['sts','get-caller-identity'],'esgiot-infra')
    operator_verified=operator['status']=='OBSERVED' and operator['data'].get('Account')=='065986019555' and bool(re.match(r'^arn:aws:sts::065986019555:assumed-role/AWSReservedSSO_FDP-InfraSetup_[A-Za-z0-9]+/',operator['data'].get('Arn','')))
    functions=aws(['lambda','list-functions'],query="Functions[?starts_with(FunctionName, 'fdp-test-qa09-')].{name:FunctionName,codeSha256:CodeSha256,role:Role}")
    projects=aws(['codebuild','list-projects'],query="projects[?starts_with(@, 'fdp-test-qa09-')]")
    verifier=aws(['iam','get-role','--role-name','fdp-test-qa09-license-verifier-role'],query='Role.{arn:Arn,trust:AssumeRolePolicyDocument}')
    users={}
    for kind in ['viewer','provisioner']:
        users[kind]=aws(['cognito-idp','admin-get-user','--user-pool-id','ap-southeast-1_hZMX8LpFo',
            '--username',identity[kind+'Username']],query='{username:Username,enabled:Enabled,status:UserStatus}')
    result={'status':'PASS_W06_PREFLIGHT' if operator_verified else 'BLOCKED_OPERATOR_IDENTITY','capturedAt':datetime.now(timezone.utc).isoformat(),
        'scope':'PARTIAL_PREPARATION_W06_READY_OTHER_WRITES_REQUIRE_EXISTING_BOUND_WRITER',
        'operator':{'profile':'esgiot-infra','expectedAccountAndRoleVerified':operator_verified,'observationStatus':operator['status'], 'errorCategory':operator.get('errorCategory')},
        'localKeyCsrPermissionsAndBinding':'PASS','requestHashBinding':'PASS','sourceCandidate':'d1a7b81196d60ec320e760da3d18de403563fc12',
        'currentExactCandidateDeploymentProven':False,'functionsInventory':functions,'projectsInventory':projects,
        'licenseVerifierRole':verifier,'ownPlannedIdentities':users,'cloudWrites':0,
        'doNotCreateOrphanCognitoUsersBeforeDatabaseWriterIsReady':True}
    dump('preflight.json',result)
    print(json.dumps({'status':result['status'],'operatorVerified':operator_verified,
        'privateKeyCsr':'PASS','functionsInventory':functions['status'],'projectsInventory':projects['status'],'cloudWrites':0}))


if __name__=='__main__':main()
