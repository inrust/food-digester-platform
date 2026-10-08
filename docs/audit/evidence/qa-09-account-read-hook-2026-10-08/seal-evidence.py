"""Seal local hook/deployment checks, keeping target business acceptance open."""
import hashlib, json, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[3]
sha=lambda b:hashlib.sha256(b).hexdigest()
for name in ['verify','targeted-vitest','targeted-node','timeout-recheck']:
 assert (ROOT/(name+'.exit')).read_text().strip()=='0',name
paths=subprocess.check_output(['git','diff','--name-only','-z'],cwd=REPO).decode().strip('\0').split('\0')
paths += ['scripts/qa09-account-read-config.mjs','scripts/qa09-account-read-config.test.mjs','docs/audit/QA-09-默认关闭账号读取候选hook与部署闭环-2026-10-08.md']
checks={}
for n in ['device-contracts','iot-integration','core-api-integration','admin-e2e','security','reliability','prototype-regression']:
 p=Path('/tmp/fdp-'+n+'-gate.json');j=json.loads(p.read_bytes());assert j['status']=='PASS',n
 target=ROOT/('local-'+n+'-gate.json');target.write_bytes(p.read_bytes());checks[n]={'gate':'PASS','sha256':sha(target.read_bytes()),'scope':'LOCAL_NOT_TARGET'}
result={
 'task':'QA-09','gate':'LOCAL_PASS_TARGET_AWAITING_MANUAL_PUSH','scope':'DEFAULT_OFF_ACCOUNT_READ_ADMIN_HOOK_AND_DEPLOYMENT_CONFIG_CLOSURE',
 'implementationParentCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),
 'default':False,'pushEnforcedOff':True,'r1Requires':['test','pool1','engine','preconnect'],
 'capacityChanged':False,'iamKmsChanged':False,'cloudFixturesCreated':0,
 'targetSameShaCiDeployment19Artifacts':'NOT_RUN_NO_RECEIPT','targetR0R1CleanupRestore':'NOT_RUN_NO_RECEIPT','matchedColdBenefit':'NOT_ESTABLISHED','qa09Gate':'PARTIAL','p95Accepted':False,'fullQa09Accepted':False,
 'checks':{'fullVerifyExit':0,'applicationTests':1448,'targetedVitest':53,'targetedNode':39,'timeoutRecheck':10,'localSuites':checks},
 'preservedFailure':'verify-first-timeout (one consumables list timeout; root cause not established)',
 'sourceHashes':{p:sha((REPO/p).read_bytes()) for p in paths},
 'next':'HUMAN_GITHUB_DESKTOP_PUSH_THEN_NEW_SHA_DEFAULT_OFF_19_ARTIFACTS_R0_CLEANUP_R1_CLEANUP_FALSE_RESTORE',
}
(ROOT/'result.json').write_text(json.dumps(result,indent=2)+'\n')
files={str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(ROOT.rglob('*')) if p.is_file() and p.name!='manifest.json'}
(ROOT/'manifest.json').write_text(json.dumps({'gate':'SEALED','algorithm':'SHA256','files':files},indent=2)+'\n')
print(json.dumps({'gate':result['gate'],'sealedFiles':len(files)}))
