import os,json,subprocess,sys,hashlib
from pathlib import Path
phase=sys.argv[1]
assert phase in ['observability','capacity','immediate']
values=json.loads(Path('docs/audit/evidence/qa-09-phased-deployment-2026-10-03/github-vars.json').read_text())
variables={x['name']:x['value'] for x in values}
config=json.loads(Path('infra/environments/esgiot-test.json').read_text())
for key,name in {'deviceApiCertificateArn':'FDP_DEVICE_API_CERTIFICATE_ARN','publicApiCertificateArn':'FDP_PUBLIC_API_CERTIFICATE_ARN','deviceApiTruststoreBucketName':'FDP_TRUSTSTORE_BUCKET_NAME','deviceApiTruststoreVersion':'FDP_TRUSTSTORE_VERSION'}.items():config[key]=variables[name]
config.update(enableRequestObservability=True,enableQa09Capacity=phase in ['capacity','immediate'],enableImmediateCommandPublish=phase=='immediate')
reviewed=Path('docs/audit/evidence/qa-09-phased-deployment-2026-10-03')/(phase+'-reviewed-template.json')
assert reviewed.read_bytes()==Path('infra/cdk.out/AppDependencies.template.json').read_bytes(),'ASSEMBLY_DRIFT'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()=='7c6f356b6917accd6cf562cb4bd6d5990416740f'
assert subprocess.run(['git','diff','--quiet','--','apps','packages','contracts','scripts/esgiot-cdk.mjs']).returncode==0,'RUNTIME_SOURCE_DRIFT'
args=['pnpm','--filter','@fdp/infra','exec','cdk','deploy','AppDependencies','--profile','esgiot-infra','--require-approval','never']
for key,value in config.items():args+=['-c',key+'='+str(value).lower() if isinstance(value,bool) else key+'='+str(value)]
env={**os.environ,'PATH':'/Users/anray/.nvm/versions/node/v24.12.0/bin:'+os.environ['PATH'],'AWS_REGION':'ap-southeast-1'}
sys.exit(subprocess.run(args,env=env).returncode)
