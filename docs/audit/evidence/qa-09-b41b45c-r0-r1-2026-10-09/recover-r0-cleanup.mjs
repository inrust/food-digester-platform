import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import {AuthFlow} from '../../../../apps/admin-web/src/auth/auth-flow.ts';
import {createCognitoIdpClient} from '../../../../apps/admin-web/src/auth/cognito-idp.ts';
import {runFixture} from '../../../../scripts/qa09-ten-device-bridge.mjs';
import {cleanupOwnedDomain} from '../../../../scripts/qa09-owned-domain-cleanup.mjs';
const root=dirname(fileURLToPath(import.meta.url)),p=join(root,'r0'),out=join(p,'cleanup-recovery.json');
const hash=b=>createHash('sha256').update(b).digest('hex'),bindings={};
const read=n=>{const b=readFileSync(join(p,n));bindings[n]=hash(b);return JSON.parse(b);};
const demand=(v,c)=>{if(!v)throw Error(c);};
demand(!existsSync(out),'NO_RECOVERY_REPLAY');
const child=read('sample.json'),parent=read('sample.json.fixtures.json'),recovered=read('business-cleanup-recovered.json');
const sha='b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e';
demand(child.sourceCommit===sha&&parent.sourceCommit===sha&&child.gate==='FAIL'&&parent.gate==='FAIL'&&child.finishedAt&&parent.finishedAt,'EXACT_FINISHED_FAILED_UNIT_REQUIRED');
demand(child.cleanupFailure.code==='AWS_batch-get-builds_CLI_FAILED'&&child.checks.length===115&&child.checks.every(c=>c.result==='PASS'),'EXACT_CLEANUP_TRANSPORT_FAILURE_REQUIRED');
demand(/^qa09-[a-f0-9]{16}$/.test(child.prefix)&&child.prefix===parent.prefix&&JSON.stringify(child.devices)===JSON.stringify(parent.devices)&&JSON.stringify(child.customers)===JSON.stringify(parent.customers),'OWN_LEDGER_REQUIRED');
demand(parent.target.accountId==='065986019555'&&parent.target.region==='ap-southeast-1'&&parent.mode==='REAL_EXISTING_TEST_ENVIRONMENT','TEST_TARGET_REQUIRED');
demand(parent.devices.length===10&&parent.devices.every((id,i)=>id===parent.prefix+'-'+String(i+1).padStart(2,'0'))&&parent.customers.length===2&&parent.customers.every((c,i)=>c.name===parent.prefix+(i?'-b':'-a')),'EXACT_OWN_DEVICE_CUSTOMER_SET');
demand(child.createdSites.length===2&&child.createdSites.every(s=>parent.customers.some(c=>c.id===s.customerId))&&child.createdIdentities.length===4,'EXACT_OWN_SITE_IDENTITY_SET');
demand(recovered.gate==='PASS'&&recovered.build.status==='SUCCEEDED'&&recovered.result.prefix===child.prefix&&recovered.result.action==='business-cleanup'&&Object.values(recovered.result.counts).every(n=>n===0),'COMPLETED_BUSINESS_CLEANUP_REQUIRED');
const originalCleanup=read('sample.json.business-cleanup-1.json');
demand(recovered.recoveredFromSha256===bindings['sample.json.business-cleanup-1.json']&&originalCleanup.build.id===recovered.build.id,'EXISTING_BUILD_BINDING');
const initial=JSON.parse(readFileSync(parent.databaseBuilds.find(b=>b.action==='observe').receipt));
const baseline=JSON.parse(readFileSync(child.databaseBuilds.find(b=>b.action==='business-baseline').receipt));
demand(initial.gate==='PASS'&&baseline.gate==='PASS'&&initial.result.prefix===child.prefix&&baseline.result.prefix===child.prefix,'ORIGINAL_BASELINES_REQUIRED');
const r={gate:'RUNNING',scope:'EXACT_FAILED_R0_CLEANUP_ONLY_NO_BUSINESS_REPLAY',mode:parent.mode,target:parent.target,sourceCommit:sha,prefix:child.prefix,devices:parent.devices,customers:parent.customers,startedAt:new Date().toISOString(),cleanup:[],databaseBuilds:[],checks:[],bindings,originalExecutionGate:'FAIL',samplingGate:'NOT_RUN',r1Gate:'NOT_RUN',p95Accepted:false,fullQa09Accepted:false};
const save=()=>writeFileSync(out,JSON.stringify(r,null,2)+'\n');
const db=async action=>{const file=out+'.'+action+'.json';demand(!existsSync(file),'NO_DB_STEP_REPLAY');const v=await runFixture({prefix:r.prefix,devices:r.devices,customers:r.customers,action,baseline:initial.result.originalFingerprints,businessBaseline:baseline.result.businessFingerprints},file,console.log,{logProfile:'esgiot-infra'});r.databaseBuilds.push({action,receipt:file,buildId:v.build.id});save();demand(v.gate==='PASS'&&v.result.prefix===r.prefix,'DB_RESULT_BINDING');return v.result;};
const aws=args=>{const v=spawnSync('aws',[...args,'--profile','esgiot-infra','--region','ap-southeast-1','--output','json','--no-cli-pager'],{encoding:'utf8',timeout:60000});demand(v.status===0,'NORMAL_AWS_PROFILE_UNAVAILABLE');return JSON.parse(v.stdout);};
const pool='ap-southeast-1_hZMX8LpFo',username=child.prefix+'-cleanup-recovery@example.invalid';let cognito,created=false,flow,token;
save();
try{
 const identity=aws(['sts','get-caller-identity']);demand(identity.Account===parent.target.accountId&&identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'),'WRONG_IDENTITY');
 const audit=await db('business-audit');demand(JSON.stringify(audit.businessFingerprints)===JSON.stringify(baseline.result.businessFingerprints),'EXTERNAL_BUSINESS_DRIFT');r.cleanup.push({type:'business-fixtures',result:'PASS',existingBuildId:recovered.build.id});save();
 const observed=await db('observe');demand(observed.devices.length===10&&JSON.stringify(observed.originalFingerprints)===JSON.stringify(initial.result.originalFingerprints),'EXACT_TEN_AND_ORIGINAL_FINGERPRINTS');
 const cleaned=await db('cleanup');demand(cleaned.deleted.devices===10&&JSON.stringify(cleaned.originalFingerprints)===JSON.stringify(initial.result.originalFingerprints),'EXACT_DEVICE_CLEANUP');r.cleanup.push({type:'database-fixtures',count:10,result:'PASS'});save();
 const empty=await db('audit-empty');demand(empty.empty===true&&JSON.stringify(empty.originalFingerprints)===JSON.stringify(initial.result.originalFingerprints),'INDEPENDENT_EMPTY_REQUIRED');r.independentEmptyAudit='PASS';save();
 const creds=aws(['configure','export-credentials','--format','process']);cognito=new sdk.CognitoIdentityProviderClient({region:'ap-southeast-1',credentials:{accessKeyId:creds.AccessKeyId,secretAccessKey:creds.SecretAccessKey,sessionToken:creds.SessionToken},maxAttempts:1});
 const call=(Cmd,input)=>cognito.send(new Cmd(input),{abortSignal:AbortSignal.timeout(30000)});
 const temp='A!z9'+randomBytes(24).toString('base64url'),password='A!z9'+randomBytes(24).toString('base64url');
 await call(sdk.AdminCreateUserCommand,{UserPoolId:pool,Username:username,TemporaryPassword:temp,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:username},{Name:'email_verified',Value:'true'}]});created=true;
 await call(sdk.AdminAddUserToGroupCommand,{UserPoolId:pool,Username:username,GroupName:'PlatformSuperAdmin'});
 flow=new AuthFlow({idp:createCognitoIdpClient({region:'ap-southeast-1',clientId:'5ljdjsf9g563mc1vdc7vjdjm09'}),userPoolId:pool,sessionManager:{establish(){}}});demand((await flow.login(username,temp)).status==='new-password-required','REAL_SRP_REQUIRED');const auth=await flow.submitNewPassword(password);demand(auth.status==='authenticated','REAL_SRP_REQUIRED');token=auth.session.idToken;
 const api=async(method,path,extra={})=>{const response=await fetch('https://api.bio-nexa.com'+path,{method,headers:{Authorization:'Bearer '+token,...extra},signal:AbortSignal.timeout(20000)});return {status:response.status,data:await response.json().catch(()=>null)};};
 for(const [kind,rows] of [['site',child.createdSites],['customer',parent.customers]])for(const row of rows){
  const path='/api/v1/admin/'+(kind==='site'?'sites':'customers')+'/'+row.id;const current=await api('GET',path);demand([200,404].includes(current.status),'EXACT_ENTITY_READ');
  if(current.status===200){const d=current.data.data;demand(kind==='site'?d.customerId===row.customerId&&d.name.startsWith(child.prefix+'-site-'):d.name===row.name,'ENTITY_SCOPE_DRIFT');const del=await api('DELETE',path,{'If-Match':String(d.version)});demand(del.status===200,'ENTITY_DELETE_FAILED');}
  demand((await api('GET',path)).status===404,'ENTITY_ABSENCE_REQUIRED');r.cleanup.push({type:kind,id:row.id,result:'PASS'});save();
 }
 for(const own of [...child.createdIdentities,parent.identity]){
  demand(own.username.startsWith(child.prefix+'-')&&own.username.endsWith('@example.invalid'),'IDENTITY_SCOPE');let absent=false;
  try{await call(sdk.AdminGetUserCommand,{UserPoolId:pool,Username:own.username});}catch(e){if(e.name!=='UserNotFoundException')throw e;absent=true;}
  const alreadyAbsent=absent;
  if(!absent){await call(sdk.AdminUserGlobalSignOutCommand,{UserPoolId:pool,Username:own.username});await call(sdk.AdminDeleteUserCommand,{UserPoolId:pool,Username:own.username});try{await call(sdk.AdminGetUserCommand,{UserPoolId:pool,Username:own.username});}catch(e){if(e.name!=='UserNotFoundException')throw e;absent=true;}}
  demand(absent,'IDENTITY_ABSENCE_REQUIRED');r.cleanup.push({type:'identity',username:own.username,result:'PASS',globalSignOut:alreadyAbsent?'ALREADY_ABSENT':'PASS'});save();
 }
 r.finishedAt=new Date().toISOString();save();const ledger=out+'.closed-ledger.json';writeFileSync(ledger,JSON.stringify(r,null,2)+'\n');const domain=await cleanupOwnedDomain(ledger,out+'.domain-cleanup.json');demand(domain.gate==='PASS','DOMAIN_CLEANUP_REQUIRED');r.cleanup.push({type:'license-domain-archive',result:'PASS'});r.gate='PASS';
}catch(e){r.gate='FAIL';r.errorName=e.name;r.errorCode=/^[\w:-]{1,150}$/.test(e.code??e.message)?e.code??e.message:'CLEANUP_RECOVERY_FAILED';}
finally{
 if(created)try{await cognito.send(new sdk.AdminUserGlobalSignOutCommand({UserPoolId:pool,Username:username}),{abortSignal:AbortSignal.timeout(30000)});await cognito.send(new sdk.AdminDeleteUserCommand({UserPoolId:pool,Username:username}),{abortSignal:AbortSignal.timeout(30000)});let absent=false;try{await cognito.send(new sdk.AdminGetUserCommand({UserPoolId:pool,Username:username}),{abortSignal:AbortSignal.timeout(30000)});}catch(e){absent=e.name==='UserNotFoundException';}demand(absent,'RECOVERY_IDENTITY_REMAINS');r.cleanup.push({type:'recovery-identity',username,result:'PASS',globalSignOut:'PASS'});}catch(e){r.gate='FAIL';r.cleanup.push({type:'recovery-identity',username,result:'FAIL',errorName:e.name});}
 token=undefined;r.finishedAt=new Date().toISOString();r.executorSha256=hash(readFileSync(fileURLToPath(import.meta.url)));save();if(cognito)cognito.destroy();
}
console.log(JSON.stringify({gate:r.gate,prefix:r.prefix,errorCode:r.errorCode,cleanup:r.cleanup}));process.exitCode=r.gate==='PASS'?0:1;
