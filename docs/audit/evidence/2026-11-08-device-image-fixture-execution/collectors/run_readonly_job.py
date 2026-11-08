"""One approved, pinned StartBuild. Persist attempt before mutation; never retry an unknown result."""
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[5]
BASE=Path(__file__).resolve().parents[1]
PREP=ROOT/'docs/audit/evidence/2026-11-08-device-image-fixture-preparation'
PROJECT='fdp-test-qa09-readonly-runner'


def save(name,value):
    (BASE/name).write_text(json.dumps(value,indent=2)+'\n')


def validate_request(raw,scope):
    w=next(v for v in scope['requestedWrites'] if v['id']=='W06')
    if hashlib.sha256(raw).hexdigest()!=w['requestSha256']:raise ValueError('REQUEST_HASH_DRIFT')
    req=json.loads(raw)
    if set(req)!={'projectName','buildspecOverride','environmentVariablesOverride'} or req['projectName']!=PROJECT:
        raise ValueError('REQUEST_SCOPE_DRIFT')
    if hashlib.sha256(req['buildspecOverride'].encode()).hexdigest()!=w['buildspecSha256']:
        raise ValueError('BUILDSPEC_HASH_DRIFT')
    if {v['name'] for v in req['environmentVariablesOverride']}!={'QA09_DB_MANIFEST_B64','QA09_DB_PROBE_SHA256'}:
        raise ValueError('ENVIRONMENT_OVERRIDE_DRIFT')
    return req


def validate_window(window,now):
    if window.get('approved') is not True or window.get('g4WritesAllowed') is not False:
        raise ValueError('PREPARATION_ONLY_APPROVAL_REQUIRED')
    start=datetime.fromisoformat(window['startsAt']);end=datetime.fromisoformat(window['endsAt'])
    if end-start!=timedelta(minutes=90) or not start<=now<end:raise ValueError('OUTSIDE_APPROVED_PREPARATION_WINDOW')


def run_aws(args,profile,query=None):
    cmd=['aws',*args,'--profile',profile,'--region','ap-southeast-1','--output','json','--no-cli-pager',
        '--cli-connect-timeout','5','--cli-read-timeout','15']
    if query:cmd+=['--query',query]
    try:
        p=subprocess.run(cmd,capture_output=True,text=True,timeout=30,env={**os.environ,'AWS_MAX_ATTEMPTS':'1','AWS_PAGER':''})
    except subprocess.TimeoutExpired:return {'status':'UNKNOWN' if args[1]=='start-build' else 'READ_TIMEOUT'}
    if p.returncode:
        category=next((v for v in ['AccessDeniedException','AccessDenied','InvalidInputException','ResourceNotFoundException','ExpiredToken'] if v in p.stderr),'UNCLASSIFIED_OPERATION_ERROR')
        return {'status':'REJECTED' if category!='UNCLASSIFIED_OPERATION_ERROR' else 'UNKNOWN','errorCategory':category}
    try:return {'status':'RETURNED','data':json.loads(p.stdout)}
    except json.JSONDecodeError:return {'status':'UNKNOWN'}


def start_once(window,scope):
    validate_window(window,datetime.now(timezone.utc))
    validate_request((PREP/'readonly-db-start.request.json').read_bytes(),scope)
    if (BASE/'start-attempt.json').exists():raise ValueError('PRIOR_ATTEMPT_EXISTS_NO_RETRY')
    key=hashlib.sha256((scope['runId']+':W06').encode()).hexdigest()
    save('start-attempt.json',{'state':'ATTEMPT_RECORDED_BEFORE_CALL','idempotencyKey':key,
        'requestSha256':next(v for v in scope['requestedWrites'] if v['id']=='W06')['requestSha256'],
        'attemptedAt':datetime.now(timezone.utc).isoformat(),'maximumStartCalls':1})
    result=run_aws(['codebuild','start-build','--cli-input-json','file://'+str(PREP/'readonly-db-start.request.json'),
        '--idempotency-token',key],'esgiot-infra','build.{id:id,status:buildStatus,startTime:startTime}')
    save('start-result.json',result)
    if result['status']!='RETURNED':return None
    build_id=result['data'].get('id','')
    if not re.fullmatch(re.escape(PROJECT)+r':[a-f0-9-]{36}',build_id):raise ValueError('UNEXPECTED_BUILD_ID')
    save('known-build.json',{'id':build_id,'requestSha256':next(v for v in scope['requestedWrites'] if v['id']=='W06')['requestSha256']})
    return build_id


def main():
    pre=json.loads((BASE/'preflight.json').read_text())
    if pre['status']!='PASS_W06_PREFLIGHT':raise ValueError('W06_PREFLIGHT_NOT_READY')
    if datetime.now(timezone.utc)-datetime.fromisoformat(pre['capturedAt'])>timedelta(minutes=10):
        raise ValueError('PREFLIGHT_STALE')
    scope_raw=(PREP/'write-approval-request.json').read_bytes()
    approved_bytes=subprocess.check_output(['git','show','d69f4cc3:docs/audit/evidence/2026-11-08-device-image-fixture-preparation/write-approval-request.json'],cwd=ROOT)
    if scope_raw!=approved_bytes:raise ValueError('APPROVED_SCOPE_DRIFT')
    scope=json.loads((PREP/'write-approval-request.json').read_text())
    if (BASE/'start-attempt.json').exists():raise ValueError('PRIOR_ATTEMPT_EXISTS_NO_RETRY')
    now=datetime.now(timezone.utc)
    window={'runId':scope['runId'],'approved':True,'approvalSource':'USER_DIRECTIVE_IN_CURRENT_CHAT',
        'approvalText':'批准上述 fdp-test-app 隔离准备及单设备预览启用范围，窗口为完成前置核验后起90分钟。',
        'scopeDocumentSha256':hashlib.sha256((PREP/'write-approval-request.json').read_bytes()).hexdigest(),
        'startsAt':now.isoformat(),'endsAt':(now+timedelta(minutes=90)).isoformat(),
        'timezoneForDisplay':'Asia/Shanghai','durationMinutes':90,'g4WritesAllowed':False,
        'deploymentsAllowed':False,'migrationsAllowed':False,'iamExpansionAllowed':False,'pushAllowed':False,
        'note':'W06 preflight passed. Other writes require their own existing executor/permission preconditions; no orphan identity creation.'}
    save('approved-preparation-window.json',window)
    build_id=start_once(window,scope)
    if not build_id:
        print(json.dumps({'status':'START_NOT_CONFIRMED','noRetry':True}),flush=True);return
    print(json.dumps({'status':'STARTED_KNOWN_BUILD','buildId':build_id,'startsAt':window['startsAt'],'endsAt':window['endsAt']}),flush=True)
    reads=[]
    for _ in range(90):
        validate_window(window,datetime.now(timezone.utc))
        value=run_aws(['codebuild','batch-get-builds','--ids',build_id],'esgiot-readonly',
            'builds[0].{id:id,status:buildStatus,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,logs:logs,sourceType:source.type,buildspec:source.buildspec}')
        if value['status']=='RETURNED':
            build=value['data'];reads.append({'capturedAt':datetime.now(timezone.utc).isoformat(),'status':build['status']})
            # Source is public repository code; exact original BuildSpec is needed by the collector.
            save('build.json',build);save('build-polls.json',reads)
            if build['status'] not in ['IN_PROGRESS','QUEUED']:
                print(json.dumps({'status':build['status'],'buildId':build_id}),flush=True);return
        else:
            reads.append({'capturedAt':datetime.now(timezone.utc).isoformat(),**value});save('build-polls.json',reads)
        time.sleep(5)
    print(json.dumps({'status':'POLLING_INCOMPLETE_KNOWN_BUILD','buildId':build_id,'doNotStartAgain':True}),flush=True)


if __name__=='__main__':main()
