"""Sequential C0 only: exact manual success -> provenance/version -> one own-prefix unit."""
import os,json,subprocess,shutil,hashlib
from pathlib import Path
root=Path(__file__).parent;p=root/'c0';sha='8b3babbf7a8e9405e6cd42284cdca1085501345f';run='37576844904'
env={**os.environ,'QA09_EXPECTED_COMMIT':sha,'QA09_DEPLOY_RUN_ID':run,'QA09_CODE_RANGE_TRANSPORT':'sdk','QA09_CODE_RANGE_TIMEOUT_MS':'180000','QA09_CODE_RANGE_CONCURRENCY':'32'}
def call(name,args):
 (p/(name+'.command.json')).write_text(json.dumps(args,indent=2)+'\n')
 with (p/(name+'.stdout.log')).open('w') as out,(p/(name+'.stderr.log')).open('w') as err:
  code=subprocess.run(args,stdout=out,stderr=err,env=env).returncode
 (p/(name+'.exit')).write_text(str(code)+'\n');print(name,code,flush=True);assert code==0,name
call('wait-success',['gh','run','watch',run,'--exit-status','--interval','30'])
call('bind-deployment',['python3',str(root/'bind-unit-deployment.py'),'c0',run])
call('collect-diff',['python3',str(root/'collect-cdk-diff.py'),'c0',run])
source=root/'push/application-version.json';dest=p/'application-version.json'
assert not dest.exists(),'NO_OVERWRITE_VERSION'
shutil.copyfile(source,dest)
(p/'artifact-reuse-origin.json').write_text(json.dumps({'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'IMMUTABLE_MATCHED_CODE_SHA_BUCKET_KEY_BYTES_ONLY_FRESH_19_CONFIG_READS'},indent=2)+'\n')
call('collection',['node','scripts/collect-qa09-application-version.mjs',str(dest),'--retry-unverified'])
v=json.loads(dest.read_text());assert v['gate']=='PASS' and len(v['lambdaArtifacts'])==19 and v['sourceCommit']==sha
capacity=json.loads((p/'capacity-before-gate.json').read_text());assert capacity['gate']=='PASS' and capacity['usableConnections']==70
call('run-business',['python3',str(root/'run-business.py'),str(p)])
