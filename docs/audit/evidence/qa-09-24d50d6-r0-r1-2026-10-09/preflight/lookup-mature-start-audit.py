import json,subprocess,datetime,hashlib
from pathlib import Path
p=Path(__file__).parent;prep=json.loads((p/'capacity-before.json.preparation.json').read_text());original=json.loads((p/'capacity-before.json').read_text());now=datetime.datetime.now(datetime.timezone.utc);start=original['operations'][-1]['startedAt'];rows=[];sameProject=[];token=None;eventCount=0
for page in range(3):
 args=['aws','cloudtrail','lookup-events','--lookup-attributes','AttributeKey=EventName,AttributeValue=StartBuild','--start-time',start,'--end-time',now.isoformat(),'--max-results','50','--no-paginate','--profile','esgiot-infra','--region','ap-southeast-1','--output','json','--no-cli-pager','--cli-connect-timeout','10','--cli-read-timeout','15']
 if token:args+=['--next-token',token]
 q=subprocess.run(args,capture_output=True,text=True,timeout=45)
 assert q.returncode==0,'READ_ONLY_CLOUDTRAIL_LOOKUP_FAILED'
 v=json.loads(q.stdout)
 for e in v.get('Events',[]):
  eventCount+=1
  c=json.loads(e['CloudTrailEvent']);req=c.get('requestParameters') or {};vars=req.get('environmentVariablesOverride') or []
  if req.get('projectName')==prep['project']['name']:
   sameProject.append({'eventId':e['EventId'],'eventTime':e['EventTime'],'errorCode':c.get('errorCode'),'buildId':(c.get('responseElements') or {}).get('build',{}).get('id'),'overrideNames':[x.get('name') for x in vars],'hasExactPlan':any(x.get('name')=='QA09_FIXTURE_PLAN_B64' and x.get('value')==next(x['value'] for x in prep['project']['environment']['environmentVariables'] if x['name']=='QA09_FIXTURE_PLAN_B64') for x in vars)})
  if req.get('projectName')==prep['project']['name'] and any(x.get('name')=='QA09_FIXTURE_PLAN_B64' and x.get('value')==next(x['value'] for x in prep['project']['environment']['environmentVariables'] if x['name']=='QA09_FIXTURE_PLAN_B64') for x in vars):
   rows.append({'eventId':e['EventId'],'eventTime':e['EventTime'],'eventSource':c.get('eventSource'),'errorCode':c.get('errorCode'),'buildId':(c.get('responseElements') or {}).get('build',{}).get('id')})
 token=v.get('NextToken')
 if not token:break
assert not token,'CLOUDTRAIL_WINDOW_INCOMPLETE'
out={'scope':'EXACT_PLAN_STARTBUILD_MANAGEMENT_EVENT_READ_ONLY','checkedAt':now.isoformat(),'startTime':start,'originalReceiptSha256':hashlib.sha256((p/'capacity-before.json').read_bytes()).hexdigest(),'exactEvents':rows,'sameProjectEvents':sameProject,'eventsRead':eventCount,'positiveControlBuildId':'fdp-test-qa09-ten-device-fixtures:f3baf781-9e67-4c31-b76e-a937b5294b00','completeReadWindow':True,'absenceDoesNotProveNoDelayedEvent':True,'writes':0}
output=p/'mature-start-cloudtrail.json';assert not output.exists();output.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
