"""Offline exact-reader smoke test: mocked AWS only, no target requests."""
import pathlib,tempfile,json,uuid,datetime,hashlib,subprocess,sys,runpy,contextlib,io
root=pathlib.Path(__file__).parent.parent
results=[]
for mode in ['r0','r1']:
 with tempfile.TemporaryDirectory(prefix='qa09-exact-test-') as tmp:
  p=pathlib.Path(tmp);rid=str(uuid.uuid4());lid=str(uuid.uuid4());epoch=1791432000000;started=datetime.datetime.fromtimestamp(epoch/1000,datetime.timezone.utc).isoformat()
  gateway={'requestId':rid,'extendedRequestId':'extended','integrationRequestId':lid,'requestTimeEpoch':str(epoch),'httpMethod':'PATCH','status':'409','integrationStatus':'200','functionStatus':'409'}
  source={'prefix':'qa09-1234567890abcdef','sourceCommit':'17fb6f10443f74d05ae3686928b9f2ed575d9b05','fullQa09Accepted':False,'cold409Sampling':{'gate':'PASS','attempts':[{'id':'cold:1:0','startedAt':started,'observation':{'method':'PATCH','gatewayRequestId':rid,'gatewayExtendedRequestId':'extended','status':409,'latencyMs':100,'responseReceived':True}}]}}
  (p/'source.json').write_text(json.dumps(source));prior={'prefix':source['prefix'],'sourceCommit':source['sourceCommit'],'sourceReceiptSha256':hashlib.sha256((p/'source.json').read_bytes()).hexdigest(),'records':[{'requestId':rid,'gateway':[gateway]}]};(p/'prior.json').write_text(json.dumps(prior))
  def mocked(args,**kwargs):
   common={'gatewayRequestId':rid,'lambdaRequestId':lid,'operationId':'updateContract','unsafe':'SECRET_SENTINEL'}
   messages=[gateway] if '/apigateway/' in args[args.index('--log-group-name')+1] else [dict(common,event='admin.request.completed',gatewayExtendedRequestId='extended',status=409,elapsedMs=30),dict(common,event='data-path.phase.completed',phase='contract-load-delegate',completionBoundary='MODEL_EXTENSION_ENTERED',processCpuScope='PROCESS_ALL_THREADS',processCpuUserUs=120),dict(common,event='data-path.contract-load.ownership',modelEntries=1,driverDispatches=1,transactional=True)]
   events=[{'message':json.dumps(m)} for m in messages]
   if len(messages)>1:events.append({'message':f'REPORT RequestId: {lid}\tDuration: 30.50 ms\tInit Duration: 80.25 ms'})
   return subprocess.CompletedProcess(args,0,json.dumps({'events':events}),'')
  oldrun=subprocess.run;oldargv=sys.argv
  try:
   subprocess.run=mocked;sys.argv=[str(root/mode/'collect-exact-invocation.py'),str(p/'source.json'),str(p/'output.json'),str(p/'prior.json'),'--cold-sampling']
   with contextlib.redirect_stdout(io.StringIO()):runpy.run_path(sys.argv[0],run_name='__main__')
  finally:subprocess.run=oldrun;sys.argv=oldargv
  raw=(p/'output.json').read_text();out=json.loads(raw);assert out['gate']=='PASS' and out['exactLinkedCount']==1 and 'SECRET_SENTINEL' not in raw
  assert out['records'][0]['phases'][0]['completionBoundary']=='MODEL_EXTENSION_ENTERED'
  assert out['records'][0]['contractLoadOwnership'][0]['transactional'] is True
  results.append({'mode':mode,'gate':'PASS','collectorSha256':out['collectorSha256'],'mockedAws':True,'ownershipAndNewBoundaryPreserved':True,'unknownFieldsDropped':True})
(root/'preflight/exact-helper-test.json').write_text(json.dumps({'gate':'PASS','results':results},indent=2)+'\n');print('exact helper offline PASS',len(results))
