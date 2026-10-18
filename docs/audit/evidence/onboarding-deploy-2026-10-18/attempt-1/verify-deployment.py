from pathlib import Path
import subprocess, os, json, hashlib, base64, tempfile, zipfile, concurrent.futures
ROOT=Path(__file__).resolve().parents[5]
OUT=Path(__file__).parent
SHA='24317c4cbe22318666c2ac7caae9e82f7e437eaa'
def aws(args):
 r=subprocess.run(['aws',*args,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager','--cli-connect-timeout','5','--cli-read-timeout','60'],capture_output=True,text=True,timeout=90,env={**os.environ,'AWS_MAX_ATTEMPTS':'1'})
 if r.returncode:raise RuntimeError('AWS_READ_FAILED: '+r.stderr[:500])
 return json.loads(r.stdout or '{}')
def h(b):return hashlib.sha256(b).hexdigest()
def main():
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()==SHA
 assert not subprocess.check_output(['git','diff','HEAD','--','apps','packages','contracts','infra'],cwd=ROOT)
 expected=json.load(open(ROOT/'infra/cdk.out/AppDependencies.template.json'))
 remote=aws(['cloudformation','get-template','--stack-name','fdp-test-app','--template-stage','Original'])['TemplateBody']
 if isinstance(remote,str):remote=json.loads(remote)
 stack=aws(['cloudformation','describe-stacks','--stack-name','fdp-test-app','--query','Stacks[0].{StackId:StackId,StackStatus:StackStatus,LastUpdatedTime:LastUpdatedTime}'])
 assert stack['StackStatus']=='UPDATE_COMPLETE'
 functions=[]
 for logical,r in expected['Resources'].items():
  if r['Type']=='AWS::Lambda::Function':
   assert remote['Resources'][logical]['Properties']==r['Properties'],logical
   functions.append((logical,r))
 assert len(functions)==19
 with tempfile.TemporaryDirectory(prefix='onboarding-runtime-') as tmp:
  def verify(item):
   logical,r=item;props=r['Properties'];name=props['FunctionName'];code=props['Code'];asset=r['Metadata']['aws:asset:path'];asset=ROOT/'infra/cdk.out'/asset
   cfg=aws(['lambda','get-function-configuration','--function-name',name,'--query','{FunctionName:FunctionName,State:State,LastUpdateStatus:LastUpdateStatus,CodeSha256:CodeSha256,RevisionId:RevisionId,LastModified:LastModified}'])
   assert cfg['State']=='Active' and cfg['LastUpdateStatus']=='Successful',name
   head=aws(['s3api','head-object','--bucket',code['S3Bucket'],'--key',code['S3Key'],'--query','{VersionId:VersionId,ContentLength:ContentLength,ETag:ETag}'])
   path=Path(tmp)/(name+'.zip');args=['s3api','get-object','--bucket',code['S3Bucket'],'--key',code['S3Key']]
   if head.get('VersionId'):args+=['--version-id',head['VersionId']]
   aws([*args,str(path)])
   raw=path.read_bytes();assert base64.b64encode(hashlib.sha256(raw).digest()).decode()==cfg['CodeSha256'],name
   with zipfile.ZipFile(path) as z:
    actual={n:h(z.read(n)) for n in z.namelist() if not n.endswith('/')}
   local={str(p.relative_to(asset)):h(p.read_bytes()) for p in asset.rglob('*') if p.is_file()}
   assert actual==local,(name,'ASSET_TREE_BYTES_DIFFER')
   return {'logicalId':logical,'name':name,'configuration':cfg,'code':code,'s3':head,'zipSha256':h(raw),'assetTreeSha256':h(json.dumps(actual,sort_keys=True).encode()),'fileCount':len(actual),'localAssetTreeMatches':True}
  with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=list(pool.map(verify,functions))
 result={'gate':'PASS','scope':'EXACT_COMMIT_TEMPLATE_AND_ALL_LAMBDA_ZIP_BYTES','sourceCommit':SHA,'stack':stack,'functionsVerified':len(rows),'functions':rows,'fullQa09Accepted':False,'productionReady':False}
 (OUT/'deployed-version.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'gate':'PASS','sourceCommit':SHA,'functionsVerified':len(rows)}))
if __name__=='__main__':main()
