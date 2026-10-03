import json,pathlib,subprocess,uuid,time,sys
p=pathlib.Path('docs/audit/evidence/qa-09-performance-remediation-2026-10-03');mode=sys.argv[1];assert mode in ['apply','revoke']
base=['aws','--profile','esgiot-infra','--region','ap-southeast-1','--output','json','--no-cli-pager']
def aws(args):
 r=subprocess.run(base+args,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr[:1500])
 return json.loads(r.stdout) if r.stdout.strip() else {}
x=aws(['cloudformation','get-template','--stack-name','fdp-test-app'])['TemplateBody'];current=json.loads(x) if isinstance(x,str) else x
addition=json.loads((p/'dlq-key-temporary-exact-addition.json').read_text());k=addition['logicalId'];sid=addition['Statement']['Sid']
if mode=='apply':
 original=json.loads((p/'dlq-current-template.json').read_text())['TemplateBody'];original=json.loads(original) if isinstance(original,str) else original
 assert current==original,'BASELINE_DRIFT'
 candidate=json.loads((p/'dlq-key-temporary-reviewed-template.json').read_text())
 assert candidate['Resources'][k]['Properties']['KeyPolicy']['Statement'][-1]==addition['Statement']
else:
 candidate=json.loads(json.dumps(current));statements=candidate['Resources'][k]['Properties']['KeyPolicy']['Statement'];owned=[s for s in statements if s.get('Sid')==sid]
 assert owned==[addition['Statement']],'TEMPORARY_STATEMENT_DRIFT'
 candidate['Resources'][k]['Properties']['KeyPolicy']['Statement']=[s for s in statements if s.get('Sid')!=sid]
changed=[key for key in current['Resources'] if current['Resources'][key]!=candidate['Resources'][key]];assert changed==[k],changed
assert set(current['Resources'])==set(candidate['Resources']);assert {a:b for a,b in current.items() if a!='Resources'}=={a:b for a,b in candidate.items() if a!='Resources'}
file=p/('dlq-'+mode+'-executed-template.json');file.write_text(json.dumps(candidate,separators=(',',':'))+'\n')
key='qa09-diagnostics/dlq/'+uuid.uuid4().hex+'/'+mode+'-template.json';bucket='fdp-test-cdk-assets-065986019555-ap-southeast-1'
upload=aws(['s3api','put-object','--bucket',bucket,'--key',key,'--body',str(file)]);(p/('dlq-'+mode+'-template-upload.json')).write_text(json.dumps({'bucket':bucket,'key':key,'result':upload},indent=2)+'\n')
name='qa09-dlq-'+mode+'-'+uuid.uuid4().hex[:12]
created=aws(['cloudformation','create-change-set','--stack-name','fdp-test-app','--change-set-name',name,'--change-set-type','UPDATE','--template-url','https://'+bucket+'.s3.ap-southeast-1.amazonaws.com/'+key,'--capabilities','CAPABILITY_NAMED_IAM','--parameters','ParameterKey=BootstrapVersion,UsePreviousValue=true','--role-arn','arn:aws:iam::065986019555:role/fdp-test-cloudformation-execution-role']);(p/('dlq-'+mode+'-change-set-created.json')).write_text(json.dumps(created,indent=2)+'\n')
for i in range(90):
 described=aws(['cloudformation','describe-change-set','--stack-name','fdp-test-app','--change-set-name',name]);status=described['Status']
 if status!='CREATE_IN_PROGRESS' and status!='CREATE_PENDING':break
 time.sleep(5)
(p/('dlq-'+mode+'-change-set-reviewed.json')).write_text(json.dumps(described,indent=2)+'\n')
assert status=='CREATE_COMPLETE',described.get('StatusReason')
changes=[v['ResourceChange'] for v in described['Changes']];assert len(changes)==1 and changes[0]['LogicalResourceId']==k and changes[0]['Action']=='Modify' and changes[0]['Replacement']=='False',changes
aws(['cloudformation','execute-change-set','--stack-name','fdp-test-app','--change-set-name',name]); print('EXACT_KEY_CHANGE_EXECUTED',mode,flush=True)
for i in range(120):
 state=aws(['cloudformation','describe-stacks','--stack-name','fdp-test-app','--query','Stacks[0].{status:StackStatus,updated:LastUpdatedTime,role:RoleARN}'])
 if state['status'] not in ['UPDATE_IN_PROGRESS','UPDATE_COMPLETE_CLEANUP_IN_PROGRESS']:break
 time.sleep(5)
(p/('dlq-'+mode+'-stack-result.json')).write_text(json.dumps(state,indent=2)+'\n');assert state['status']=='UPDATE_COMPLETE',state
print('EXACT_KEY_CHANGE_PASS',mode,flush=True)
