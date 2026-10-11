"""Single bounded readonly CloudTrail read; persist exact own Plan matches only."""
from pathlib import Path
import datetime,hashlib,json,os,subprocess
root=Path(__file__).parent.parent;p=root/'r0/sample.json.business-audit-2.json';raw=p.read_bytes();v=json.loads(raw);prep=json.loads(Path(str(p)+'.preparation.json').read_text());out=root/'recovery/unknown-start-cloudtrail-final.json';assert not out.exists()
start=datetime.datetime.fromisoformat(next(x['startedAt'] for x in v['operations'] if x['operation']=='start-build').replace('Z','+00:00'));end=datetime.datetime.now(datetime.timezone.utc)
args=['aws','cloudtrail','lookup-events','--lookup-attributes','AttributeKey=EventName,AttributeValue=StartBuild','--start-time',(start-datetime.timedelta(minutes=5)).isoformat(),'--end-time',end.isoformat(),'--max-results','50','--no-paginate','--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager','--cli-connect-timeout','10','--cli-read-timeout','15']
q=subprocess.run(args,capture_output=True,text=True,timeout=45,env={**os.environ,'AWS_MAX_ATTEMPTS':'1'});result=dict(scope='EXACT_UNKNOWN_START_CLOUDTRAIL_READ_ONLY_NO_RESTART',sourceReceiptSha256=hashlib.sha256(raw).hexdigest(),reads=1,writes=0,originalStartGate='UNKNOWN',otherEventsPersisted=False,checkedAt=end.isoformat())
if q.returncode:
 result.update(gate='UNAVAILABLE',cliExit=q.returncode,errorCode='BOUNDED_CLOUDTRAIL_READ_FAILED')
else:
 data=json.loads(q.stdout);vars={x['name']:x['value'] for x in prep['project']['environment']['environmentVariables']};matches=[]
 for e in data.get('Events',[]):
  j=json.loads(e['CloudTrailEvent']);r=j.get('requestParameters') or {};envs={x.get('name'):x.get('value') for x in r.get('environmentVariablesOverride',[])}
  if r.get('projectName')==prep['project']['name'] and all(envs.get(k)==vars[k] for k in ['QA09_FIXTURE_HASH','QA09_FIXTURE_PLAN_B64']):
   matches.append(dict(eventId=e['EventId'],eventTime=e['EventTime'],requestId=j.get('requestID'),errorCode=j.get('errorCode'),responseBuildId=(j.get('responseElements') or {}).get('build',{}).get('id')))
 result.update(gate='OBSERVED' if matches else 'NOT_OBSERVED',scannedEvents=len(data.get('Events',[])),pageTruncated=bool(data.get('NextToken')),matches=matches,absenceProvesNonExecution=False)
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
