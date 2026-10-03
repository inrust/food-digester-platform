import subprocess,json,datetime,hashlib,concurrent.futures,pathlib,argparse
a=argparse.ArgumentParser();a.add_argument("--target");a.add_argument("--output",default="docs/audit/evidence/qa-09-performance-readonly-diagnostic-2026-10-03.json");a.add_argument("--start",default="2026-10-03T00:00:00Z");a.add_argument("--end",default="2026-10-03T03:30:00Z");a=a.parse_args()
start_ms=str(int(datetime.datetime.fromisoformat(a.start.replace("Z","+00:00")).timestamp()*1000));end_ms=str(int(datetime.datetime.fromisoformat(a.end.replace("Z","+00:00")).timestamp()*1000))
r={'task':'QA-09','scope':'HTTP_REQUEST_CORRELATION_AND_CAPACITY_READ_ONLY','collectedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'accountId':'065986019555','sharedConfigurationChanged':False,'observations':{},'errors':[]}
def aws(args):
 p=subprocess.run(['aws',*args,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager'],capture_output=True,text=True,timeout=45)
 if p.returncode: raise RuntimeError('AWS_READ_FAILED:'+args[0]+':'+args[1])
 return json.loads(p.stdout)
assert aws(['sts','get-caller-identity'])['Account']==r['accountId']
def collect(key,args):
 try:r['observations'][key]=aws(args)
 except Exception as e:r['errors'].append({'key':key,'code':str(e)})
collect('adminStage',['apigateway','get-stage','--rest-api-id','ldark4ozek','--stage-name','test','--query','{accessLogSettings:accessLogSettings,methodSettings:methodSettings,tracingEnabled:tracingEnabled}'])
collect('executionLogGroups',['logs','describe-log-groups','--log-group-name-prefix','API-Gateway-Execution-Logs_ldark4ozek','--query','logGroups[].logGroupName'])
collect('database',['rds','describe-db-instances','--db-instance-identifier','fdp-test-db','--query','DBInstances[0].{Class:DBInstanceClass,Status:DBInstanceStatus,ParameterGroups:DBParameterGroups,Engine:EngineVersion}'])
resources=aws(['cloudformation','list-stack-resources','--stack-name','fdp-test-app'])['StackResourceSummaries']
functions=[x['PhysicalResourceId'] for x in resources if x['ResourceType']=='AWS::Lambda::Function']
def concurrency(name):
 try:return {'functionName':name,**aws(['lambda','get-function-concurrency','--function-name',name])}
 except Exception as e:return {'functionName':name,'error':str(e)}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:r['observations']['lambdaConcurrency']=list(ex.map(concurrency,functions))
ids=['585c5f2b-47ef-4b5b-88ab-3a29611e0aaf','2bbadf92-9a09-4476-9e9f-669561231e1a','31f93a29-21d9-4ebe-a9c0-b7b2cd935a18','91d8dea0-ffb0-4ce6-9d2e-82b0205a955a']
if a.target:
 t=json.loads(pathlib.Path(a.target).read_text());ids=[x['requestId'] for x in t['checks'] if x.get('status')==500];r['clientRequests']=[{k:x.get(k) for k in ['id','requestId','gatewayRequestId','gatewayExtendedRequestId','status','startedAt','latencyMs']} for x in t['checks'] if x.get('status')==500];r['targetReceipt']=a.target
r['window']={'start':a.start,'end':a.end}
r['requestSearch']=[]
for rid in ids:
 try:
  d=aws(['logs','filter-log-events','--log-group-name','/aws/lambda/fdp-test-api','--start-time',start_ms,'--end-time',end_ms,'--filter-pattern','"'+rid+'"'])
  r['requestSearch'].append({'requestId':rid,'matchingEvents':len(d.get('events',[])),'paginationComplete':not bool(d.get('nextToken')),'eventDigests':[hashlib.sha256(x['message'].encode()).hexdigest() for x in d.get('events',[])]})
 except Exception as e:r['errors'].append({'requestId':rid,'code':str(e)})
for ns,name,dimension,stat in [('AWS/RDS','DatabaseConnections','Name=DBInstanceIdentifier,Value=fdp-test-db','Maximum'),('AWS/RDS','CPUUtilization','Name=DBInstanceIdentifier,Value=fdp-test-db','Maximum'),('AWS/Lambda','Throttles','Name=FunctionName,Value=fdp-test-api','Sum')]:
 collect(name,['cloudwatch','get-metric-statistics','--namespace',ns,'--metric-name',name,'--dimensions',dimension,'--start-time',a.start,'--end-time',a.end,'--period','60','--statistics',stat])
rows=r['observations']['lambdaConcurrency'];r['budget']={'databaseLambdaReservedSum':sum(x.get('ReservedConcurrentExecutions',0) for x in rows),'poolMaxPerEnvironment':2,'steadyReservedPoolCeiling':2*sum(x.get('ReservedConcurrentExecutions',0) for x in rows),'ordinarySlotsFromPriorDbReceipt':76,'slotsFreshlyMeasured':False,'rotationAndIdleOverlapCovered':False}
r['requestCorrelationGate']='NOT_PROVABLE_WITH_EXISTING_LOGS';r['gate']='PARTIAL';r['fullQa09Accepted']=False
pathlib.Path(a.output).write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'gate':r['gate'],'requestCorrelationGate':r['requestCorrelationGate'],'budget':r['budget'],'errors':r['errors']}))
