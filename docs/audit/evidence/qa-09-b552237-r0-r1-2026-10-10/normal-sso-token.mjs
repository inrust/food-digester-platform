// Normal SDK refresh of the existing authorized session; never emit or persist token material to the repo.
import { fromSso } from '@aws-sdk/token-providers';
import { parseKnownFiles, getSSOTokenFromFile } from '@smithy/shared-ini-file-loader';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const out=process.argv[2];if(!out||existsSync(out))throw Error('FRESH_METADATA_OUTPUT_REQUIRED');
const profile='esgiot-infra',profiles=await parseKnownFiles({profile}),p=profiles[profile];
if(p.sso_account_id!=='065986019555'||p.sso_role_name!=='FDP-InfraSetup')throw Error('EXISTING_TEST_PROFILE_REQUIRED');
const prior=await getSSOTokenFromFile(p.sso_session),before=prior.expiresAt;
let expiration,code='NONE';
try { const value=await fromSso({profile})();expiration=value.expiration?.toISOString(); }
catch(e){code=/^[A-Za-z][A-Za-z0-9_]{1,80}$/.test(e.name??'')?e.name:'TOKEN_PROVIDER_FAILED';}
const after=await getSSOTokenFromFile(p.sso_session);
const gate=Date.parse(expiration)===Date.parse(after.expiresAt)&&Date.parse(after.expiresAt)>Date.now()+600000?'PASS':'RENEWABLE_SESSION_REQUIRED';
const require=createRequire(import.meta.url),provider=require.resolve('@aws-sdk/token-providers');
const result={gate,scope:'NORMAL_SAME_PROFILE_SDK_TOKEN_PROVIDER_NO_PERMISSION_CHANGE',profile,session:p.sso_session,accountId:p.sso_account_id,checkedAt:new Date().toISOString(),beforeLoginExpiresAt:before,loginExpiresAt:after.expiresAt,renewed:Date.parse(after.expiresAt)>Date.parse(before),code,credentialsPersistedToRepository:false,credentialDestination:'EXISTING_STANDARD_SSO_CACHE_ONLY',providerSourceSha256:createHash('sha256').update(readFileSync(provider)).digest('hex')};
writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=gate==='PASS'?0:1;
