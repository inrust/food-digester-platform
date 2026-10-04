import json,subprocess,pathlib,datetime,time,hashlib,base64,zipfile,tempfile,uuid
p=pathlib.Path('docs/audit/evidence/qa-09-dlq-exact-key-2026-10-04');old=pathlib.Path('docs/audit/evidence/qa-09-phased-deployment-2026-10-03');base=['aws','--profile','esgiot-infra','--region','ap-southeast-1','--output','json','--no-cli-pager'];role='fdp-test-command-publisher-role';name='fdp-test-qa09-command-dlq-diagnostic';policyName='Qa09DlqDiagnostic'+uuid.uuid4().hex[:12]
def aws(args,absent=False):
 r=subprocess.run(base+args,text=True,capture_output=True)
 if r.returncode:
  if absent and ('ResourceNotFoundException' in r.stderr or 'NoSuchEntity' in r.stderr):return None
  raise RuntimeError(r.stderr[:1500])
 return json.loads(r.stdout) if r.stdout.strip() else {}
def save(n,x):(p/n).write_text(json.dumps(x,indent=2)+'\n')
originalPolicies={key:aws(['iam','get-role-policy','--role-name',role,'--policy-name',key])['PolicyDocument'] for key in aws(['iam','list-role-policies','--role-name',role])['PolicyNames']};save('dlq-worker-original-inline-policies.json',originalPolicies)
assert aws(['lambda','get-function-configuration','--function-name',name],True) is None,'DIAGNOSTIC_NAME_EXISTS'
expiry=json.loads((p/'dlq-key-temporary-exact-addition.json').read_text())['expiresAtUtc'];policy={'Version':'2012-10-17','Statement':[{'Sid':'OwnCommandDlqOnly','Effect':'Allow','Action':['sqs:GetQueueAttributes','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:ChangeMessageVisibility'],'Resource':'arn:aws:sqs:ap-southeast-1:065986019555:fdp-test-command-publish-dlq','Condition':{'DateLessThan':{'aws:CurrentTime':expiry}}}]};save('dlq-worker-temporary-inline-policy.json',policy)
created=False;policyAdded=False;out={'scope':'EXACT_RETIRED_OWN_COMMAND_DLQ_SERVICE_WORKER','functionName':name,'role':role,'policyName':policyName,'gate':'RUNNING','cleanup':[],'humanDecryptGranted':False};save('dlq-service-worker-result.json',out)
try:
 node="import {readFileSync} from 'node:fs';import {runFixture} from './scripts/qa09-ten-device-bridge.mjs';const r=JSON.parse(readFileSync('"+str(old/'immediate-slo-only.json.devices.json')+"'));await runFixture({prefix:r.prefix,devices:r.devices,customers:r.customers,action:'command-dlq-readonly'},'"+str(p/'dlq-service-fresh-database-proof.json')+"',console.log);"
 env={'PATH':'/Users/anray/.nvm/versions/node/v24.12.0/bin:'+__import__('os').environ['PATH'],**{k:v for k,v in __import__('os').environ.items() if k!='PATH'}}
 subprocess.run(['node','--import','tsx','--input-type=module','-e',node],env=env,check=True)
 proof=json.loads((p/'dlq-service-fresh-database-proof.json').read_text());assert proof['gate']=='PASS'
 validation="import {readFileSync} from 'node:fs';import {closedCommandLedger} from './scripts/qa09-command-dlq-scope.mjs';const b=JSON.parse(readFileSync('"+str(old/'immediate-slo-only.json')+"')),d=JSON.parse(readFileSync('"+str(old/'immediate-slo-only.json.devices.json')+"')),p=JSON.parse(readFileSync('"+str(p/'dlq-service-fresh-database-proof.json')+"'));console.log(closedCommandLedger(b,d,p.result).size);"
 assert subprocess.check_output(['node','--input-type=module','-e',validation],env=env,text=True).strip()=='20'
 digest=hashlib.sha256((p/'dlq-service-fresh-database-proof.json').read_bytes()).hexdigest();prefix=proof['result']['prefix']
 with tempfile.TemporaryDirectory(prefix='qa09-dlq-') as tmp:
  tmp=pathlib.Path(tmp);z=tmp/'worker.zip';sources=[]
  with zipfile.ZipFile(z,'w',compression=zipfile.ZIP_DEFLATED) as archive:
   for filename in ['qa09-command-dlq-worker.mjs','qa09-command-dlq-scope.mjs']:
    b=pathlib.Path('scripts',filename).read_bytes();archive.writestr(filename,b);sources.append({'path':'scripts/'+filename,'sha256':hashlib.sha256(b).hexdigest(),'sourceBase64':base64.b64encode(b).decode()})
  sha=base64.b64encode(hashlib.sha256(z.read_bytes()).digest()).decode();save('dlq-service-worker-source-snapshot.json',{'zipCodeSha256':sha,'sources':sources,'proofSha256':digest})
  aws(['iam','put-role-policy','--role-name',role,'--policy-name',policyName,'--policy-document','file://'+str(p/'dlq-worker-temporary-inline-policy.json')]);policyAdded=True
  config={'Variables':{'QA09_DLQ_PREFIX':prefix,'QA09_DLQ_PROOF_SHA256':digest,'QA09_DLQ_EXPIRES_AT':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=240)).isoformat()}};envFile=tmp/'env.json';envFile.write_text(json.dumps(config))
  made=aws(['lambda','create-function','--function-name',name,'--runtime','nodejs24.x','--role','arn:aws:iam::065986019555:role/'+role,'--handler','qa09-command-dlq-worker.handler','--zip-file','fileb://'+str(z),'--timeout','60','--memory-size','256','--environment','file://'+str(envFile),'--logging-config',json.dumps({'LogFormat':'JSON','LogGroup':'/aws/lambda/fdp-test-command-publisher'}),'--description','QA09 one-shot exact retired command DLQ cleanup; no secrets or MQTT','--tags',json.dumps({'fdp:env':'test','fdp:task':'QA-09'}),'--publish']);created=True
  assert made['CodeSha256']==sha and made['Role'].endswith('/'+role) and made['Version']=='1'
  for i in range(40):
   active=aws(['lambda','get-function-configuration','--function-name',name]);
   if active['State']=='Active':break
   time.sleep(2)
  assert active['State']=='Active' and active['CodeSha256']==sha and active['Role']==made['Role'];out['functionBinding']={'CodeSha256':sha,'Role':active['Role'],'Version':'1'}
  eventFile=tmp/'event.json';eventFile.write_text(json.dumps({'proofSha256':digest}));resultFile=tmp/'result.json';invoked=aws(['lambda','invoke','--function-name',name,'--qualifier','1','--cli-binary-format','raw-in-base64-out','--payload','file://'+str(eventFile),str(resultFile)]);out['invoke']=invoked;out['result']=json.loads(resultFile.read_text());out['gate']=out['result'].get('gate','FAIL');assert not invoked.get('FunctionError'),out['result']
except Exception as error:
 out['gate']='BLOCKED';out['errorType']=type(error).__name__;out['operationFailure']=str(error)[:1500]
finally:
 if created:
  aws(['lambda','delete-function','--function-name',name]);assert aws(['lambda','get-function-configuration','--function-name',name],True) is None;out['cleanup'].append({'scope':'own-diagnostic-function','result':'PASS'})
 if policyAdded:
  aws(['iam','delete-role-policy','--role-name',role,'--policy-name',policyName]);out['cleanup'].append({'scope':'own-temporary-inline-policy','result':'PASS'})
 after={key:aws(['iam','get-role-policy','--role-name',role,'--policy-name',key])['PolicyDocument'] for key in aws(['iam','list-role-policies','--role-name',role])['PolicyNames']};assert after==originalPolicies,'ORIGINAL_INLINE_POLICY_DRIFT';out['cleanup'].append({'scope':'original-inline-policies-unchanged','result':'PASS'});out['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save('dlq-service-worker-result.json',out)
print('DLQ_SERVICE_RESULT',out['gate'],flush=True)
if out['gate']!='PASS':raise SystemExit(1)
