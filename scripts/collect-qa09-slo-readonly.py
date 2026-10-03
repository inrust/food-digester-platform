"""Read SLO queue/Lambda aggregates and search the exact redelivered SQS ID."""
import datetime, hashlib, json, pathlib, subprocess, concurrent.futures
p=pathlib.Path('docs/audit/evidence/qa-09-slo-aws-archive-redelivery-2026-10-03.json');raw=p.read_bytes();q=json.loads(raw)['result']['queueRedelivery']
r={'scope':'SLO_QUEUE_AND_INGESTION_READ_ONLY','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'redeliveryReceipt':str(p),'redeliveryReceiptSha256':hashlib.sha256(raw).hexdigest(),'observations':{},'errors':[],'sharedConfigurationChanged':False,'consumptionProven':False}
def aws(args):
 x=subprocess.run(['aws',*args,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager'],capture_output=True,text=True,timeout=45)
 if x.returncode:raise RuntimeError('AWS_READ_FAILED')
 return json.loads(x.stdout or '{}')
def collect(key,args):
 try:return key,aws(args),None
 except Exception as e:return key,None,type(e).__name__
items=[]
for ns,name,dim,val,stat in [('AWS/SQS','ApproximateAgeOfOldestMessage','QueueName','fdp-test-ingress','Maximum'),('AWS/SQS','ApproximateNumberOfMessagesVisible','QueueName','fdp-test-ingress','Maximum'),('AWS/Lambda','Throttles','FunctionName','fdp-test-ingestion','Sum'),('AWS/Lambda','Errors','FunctionName','fdp-test-ingestion','Sum'),('AWS/Lambda','Duration','FunctionName','fdp-test-ingestion','Maximum')]:
 items.append((ns+'/'+name,['cloudwatch','get-metric-statistics','--namespace',ns,'--metric-name',name,'--dimensions',f'Name={dim},Value={val}','--start-time','2026-10-03T06:11:00Z','--end-time','2026-10-03T06:35:00Z','--period','60','--statistics',stat]))
items.append(('exactSqsMessageSearch',['logs','filter-log-events','--log-group-name','/aws/lambda/fdp-test-ingestion','--start-time',str(int(datetime.datetime.fromisoformat('2026-10-03T06:26:00+00:00').timestamp()*1000)),'--filter-pattern','"'+q['sqsMessageId']+'"']))
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
 for key,value,error in ex.map(lambda x:collect(*x),items):
  if error:r['errors'].append({'key':key,'errorName':error})
  elif key=='exactSqsMessageSearch':r['observations'][key]={'sqsMessageId':q['sqsMessageId'],'matchingEvents':len(value.get('events',[])),'paginationComplete':not value.get('nextToken'),'eventDigests':[hashlib.sha256(x['message'].encode()).hexdigest() for x in value.get('events',[])]}
  else:r['observations'][key]=value
r['requestCorrelationGate']='NOT_PROVEN_AGGREGATES_ARE_NOT_MESSAGE_LINKAGE';r['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
pathlib.Path('docs/audit/evidence/qa-09-slo-readonly-diagnostic-2026-10-03.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'errors':r['errors'],'consumptionProven':False}))
