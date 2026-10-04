import json,subprocess,pathlib,datetime,hashlib
p=pathlib.Path('docs/audit/evidence/qa-09-dlq-exact-key-2026-10-04');key='22af85c4-76d3-40c9-a849-0621740afe6c';sid='Qa09CommandDlqDiagnosticDecrypt';base=['aws','--profile','esgiot-infra','--region','ap-southeast-1','--output','json','--no-cli-pager']
def aws(args):
 r=subprocess.run(base+args,capture_output=True,text=True,timeout=60)
 if r.returncode: raise RuntimeError('AWS_'+args[0]+'_'+args[1]+'_FAILED')
 return json.loads(r.stdout) if r.stdout.strip() else {}
def current(): return json.loads(aws(['kms','get-key-policy','--key-id',key,'--policy-name','default'])['Policy'])
def save(n,j): (p/n).write_text(json.dumps(j,indent=2)+'\n')
r={'scope':'AUTHORIZED_ONE_KEY_ONE_WORKER_ONE_DLQ_ONLY','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gate':'RUNNING','cleanup':[]};save('key-operation-result.json',r);attempted=False
before=json.loads((p/'key-policy-before.json').read_text());candidate=json.loads((p/'key-policy-candidate.json').read_text());addition=json.loads((p/'dlq-key-temporary-exact-addition.json').read_text())['Statement']
try:
 assert current()==before,'KEY_POLICY_DRIFT_BEFORE_WRITE'
 assert candidate['Statement']==before['Statement']+[addition]
 assert addition['Condition']['DateLessThan']['aws:CurrentTime']=='2026-10-05T00:00:00Z'
 attempted=True
 aws(['kms','put-key-policy','--key-id',key,'--policy-name','default','--policy','file://'+str(p/'key-policy-candidate.json')])
 actual=current();assert actual==candidate,'KEY_POLICY_NOT_EXACT';save('key-policy-applied.json',actual);r['keyWriteGate']='PASS';save('key-operation-result.json',r)
 worker=subprocess.run(['python3',str(p/'dlq-service-worker-executor.py')]);r['workerExitCode']=worker.returncode;r['gate']='PASS' if worker.returncode==0 else 'PARTIAL'
except Exception as e:
 r['gate']='BLOCKED';r['errorType']=type(e).__name__;r['errorCode']=str(e)[:100] if str(e).replace('_','').isalnum() else 'CONTROLLED_OPERATION_FAILED'
finally:
 if attempted:
  latest=current();matches=[s for s in latest['Statement'] if s.get('Sid')==sid];assert len(matches)<=1 and (not matches or matches[0]==addition),'TEMPORARY_SID_DRIFT'
  if matches:
   latest['Statement']=[s for s in latest['Statement'] if s.get('Sid')!=sid];save('key-policy-revocation-candidate.json',latest);aws(['kms','put-key-policy','--key-id',key,'--policy-name','default','--policy','file://'+str(p/'key-policy-revocation-candidate.json')])
  restored=current();assert restored==latest;assert not any(s.get('Sid')==sid for s in restored['Statement']);save('key-policy-after.json',restored);r['cleanup'].append({'scope':'only-temporary-key-sid-removed-preserving-latest-other-statements','result':'PASS'});r['originalPolicyExactMatch']=restored==before
 r['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save('key-operation-result.json',r)
print('CONTROLLED_KEY_OPERATION',r['gate'],flush=True)
raise SystemExit(0 if r['gate']=='PASS' else 1)
