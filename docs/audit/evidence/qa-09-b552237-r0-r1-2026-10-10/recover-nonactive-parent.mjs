// Finish only the failed parent's owned cleanup; never repeat PATCH or sampling.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { runFixture } from '../../../../scripts/qa09-ten-device-bridge.mjs';
import { seedCleanupAction } from '../../../../scripts/qa09-seed-recovery.mjs';
import { cleanupOwnedDomain } from '../../../../scripts/qa09-owned-domain-cleanup.mjs';
import { AuthFlow } from '../../../../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../../../../apps/admin-web/src/auth/cognito-idp.ts';
const [dir, output] = process.argv.slice(2);
if (existsSync(output)) throw Error('FRESH_RECOVERY_OUTPUT_REQUIRED');
const hash = x => createHash('sha256').update(x).digest('hex');
const parentFile = dir + '/sample.json.fixtures.json', childFile = dir + '/sample.json';
const parent = JSON.parse(readFileSync(parentFile)), child = JSON.parse(readFileSync(childFile));
const recoveredFile = dir + '/parent-observe-recovered.json', recovered = JSON.parse(readFileSync(recoveredFile));
const first = JSON.parse(readFileSync(parent.databaseBuilds.find(x => x.action === 'observe').receipt));
if (!parent.finishedAt || parent.gate !== 'FAIL' || child.gate !== 'PASS' || !child.cleanupComplete || child.checks.length !== 123 || child.checks.some(x => x.result !== 'PASS') || parent.prefix !== child.prefix || parent.sourceCommit !== 'b5522378aebca9340a0767b53ed3bab846ffc080' || parent.target.accountId !== '065986019555' || parent.globalSignOut !== 'PASS' || recovered.gate !== 'PASS' || recovered.result.prefix !== parent.prefix || recovered.result.action !== 'observe' || recovered.sourceHash !== first.sourceHash || recovered.result.certificates.length || recovered.result.requests.length || seedCleanupAction(recovered.result, parent.devices) !== 'cleanup' || JSON.stringify(recovered.result.originalFingerprints) !== JSON.stringify(first.result.originalFingerprints)) throw Error('EXACT_FAILED_NONACTIVE_PARENT_REQUIRED');
const r = {task:'QA-09', scope:'EXACT_NONACTIVE_PARENT_CLEANUP_RECOVERY_NO_BUSINESS_REPLAY', mode:parent.mode, target:parent.target, sourceCommit:parent.sourceCommit, prefix:parent.prefix, devices:parent.devices, customers:parent.customers, startedAt:new Date().toISOString(), gate:'RUNNING', checks:[],cleanup:[],databaseBuilds:[], inputs:[parentFile,childFile,recoveredFile].map(path=>({path,sha256:hash(readFileSync(path))})), patchReplay:false, samplingReplay:false, fullQa09Accepted:false};
const save = () => writeFileSync(output, JSON.stringify(r,null,2)+'\n');
const check = (id, ok, details={}) => {r.checks.push({id,result:ok?'PASS':'FAIL',...details});save();if(!ok)throw Error('OWN_CLEANUP_RECOVERY_ASSERTION');};
save();
const exp = spawnSync('aws',['configure','export-credentials','--profile','esgiot-infra','--format','process'],{encoding:'utf8',timeout:30000});
if(exp.status!==0)throw Error('SSO_CREDENTIALS_UNAVAILABLE');
const creds = JSON.parse(exp.stdout), region='ap-southeast-1', pool='ap-southeast-1_hZMX8LpFo';
const ci = new sdk.CognitoIdentityProviderClient({region,credentials:{accessKeyId:creds.AccessKeyId,secretAccessKey:creds.SecretAccessKey,sessionToken:creds.SessionToken},maxAttempts:1});
const call = (Cmd,input) => ci.send(new Cmd(input),{abortSignal:AbortSignal.timeout(45000)});
const idp = createCognitoIdpClient({region,clientId:'5ljdjsf9g563mc1vdc7vjdjm09',fetch:async(operation,payload)=>{const commands={InitiateAuth:sdk.InitiateAuthCommand,RespondToAuthChallenge:sdk.RespondToAuthChallengeCommand,GlobalSignOut:sdk.GlobalSignOutCommand};if(!commands[operation])throw Error('AUTH_OPERATION_FORBIDDEN');return {status:200,body:await call(commands[operation],payload)};}});
const username=parent.prefix+'-parent-recovery@example.invalid';let created=false,token,accessToken;
async function db(action){const path=output+'.'+action+'.json';const result=await runFixture({prefix:parent.prefix,devices:parent.devices,customers:parent.customers,action,baseline:first.result.originalFingerprints},path,console.log);r.databaseBuilds.push({action,receipt:path,buildId:result.build.id});save();return result.result;}
async function api(id,method,path,status,headers={}){const res=await fetch('https://api.bio-nexa.com'+path,{method,headers:{Authorization:'Bearer '+token,...headers},signal:AbortSignal.timeout(45000)});const body=await res.json().catch(()=>null);check(id,res.status===status,{method,path,status:res.status,requestId:res.headers.get('x-amzn-requestid')});return body;}
try {
  const cleared=await db('cleanup');check('exact-ten-own-devices-deleted',cleared.deleted.devices===10);check('original-baseline-preserved',JSON.stringify(cleared.originalFingerprints)===JSON.stringify(first.result.originalFingerprints));r.cleanup.push({type:'database-fixtures',count:10,result:'PASS'});save();
  const temp='A!z9'+randomBytes(24).toString('base64url'),password='A!z9'+randomBytes(24).toString('base64url');
  await call(sdk.AdminCreateUserCommand,{UserPoolId:pool,Username:username,MessageAction:'SUPPRESS',TemporaryPassword:temp,UserAttributes:[{Name:'email',Value:username},{Name:'email_verified',Value:'true'}]});created=true;r.recoveryIdentity=username;save();
  await call(sdk.AdminAddUserToGroupCommand,{UserPoolId:pool,Username:username,GroupName:'PlatformSuperAdmin'});
  const flow=new AuthFlow({idp,userPoolId:pool,sessionManager:{establish(){}}});check('recovery-first-login-challenge',(await flow.login(username,temp)).status==='new-password-required');const auth=await flow.submitNewPassword(password);check('recovery-real-srp',auth.status==='authenticated');token=auth.session.idToken;accessToken=auth.session.accessToken;
  for(const c of [...parent.customers].reverse()){const path='/api/v1/admin/customers/'+c.id;const now=await api('scope-'+c.suffix,'GET',path,200);check('own-customer-name-'+c.suffix,now.data.name===parent.prefix+'-'+c.suffix);await api('delete-'+c.suffix,'DELETE',path,200,{'If-Match':String(now.data.version)});await api('absent-'+c.suffix,'GET',path,404);r.cleanup.push({type:'customer',id:c.id,result:'PASS'});save();}
  let absent=false;try{await call(sdk.AdminGetUserCommand,{UserPoolId:pool,Username:parent.identity.username});}catch(e){if(e.name!=='UserNotFoundException')throw e;absent=true;}check('original-dedicated-identity-absent',absent);r.cleanup.push({type:'identity',username:parent.identity.username,result:'PASS'});save();
  r.gate='PASS';
}catch(e){r.gate='FAIL';r.failureCode=/^[\w:-]{1,150}$/.test(e.code??e.message)?(e.code??e.message):'OWN_CLEANUP_FAILED';}
finally {if(created)try{await call(sdk.AdminUserGlobalSignOutCommand,{UserPoolId:pool,Username:username});await call(sdk.AdminDeleteUserCommand,{UserPoolId:pool,Username:username});let absent=false;try{await call(sdk.AdminGetUserCommand,{UserPoolId:pool,Username:username});}catch(e){if(e.name!=='UserNotFoundException')throw e;absent=true;}check('recovery-identity-absent',absent);r.cleanup.push({type:'recovery-identity',username,result:'PASS'});r.globalSignOut='PASS';}catch(e){r.gate='FAIL';r.cleanup.push({type:'recovery-identity',username,result:'FAIL'});}token=undefined;accessToken=undefined;r.finishedAt=new Date().toISOString();save();ci.destroy();}
if(r.gate==='PASS'){const domain=await cleanupOwnedDomain(output,output+'.domain-cleanup.json');if(domain.gate!=='PASS')throw Error('OWN_DOMAIN_NOT_CLOSED');r.cleanup.push({type:'license-domain-archive',result:'PASS'});save();}
console.log(JSON.stringify({gate:r.gate,prefix:r.prefix,cleanup:r.cleanup.length,failureCode:r.failureCode}));process.exitCode=r.gate==='PASS'?0:1;
