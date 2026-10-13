import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {URL} from 'node:url';
import console from 'node:console';
const root=new URL('./',import.meta.url),read=p=>JSON.parse(readFileSync(new URL(p,root))),sha=b=>createHash('sha256').update(b).digest('hex');
const parent=read('target.json'),child=read('target.json.reliability.json'),recovery=read('first-cleanup-recovery.json');
if(existsSync(new URL('first-recovery-final.json',root))||recovery.gate!=='PASS'||recovery.domain?.gate!=='PASS'||recovery.prefix!==parent.prefix||recovery.cleanup.length!==26||recovery.cleanup.some(c=>c.result!=='PASS'))throw Error('COMPLETED_OWN_RECOVERY_REQUIRED');
const r={gate:'RUNNING',scope:'INDEPENDENT_RECOVERED_OWN_EMPTY_AND_KNOWN_BUILD_READS',prefix:parent.prefix,sourceCommit:parent.sourceCommit,
 sourceSha256:sha(readFileSync(new URL(import.meta.url))),originalParentSha256:sha(readFileSync(new URL('target.json',root))),
 recoverySha256:sha(readFileSync(new URL('first-cleanup-recovery.json',root))),originalTaskGate:child.gate,originalStartGate:'UNKNOWN',
 originalPlanRestarted:false,businessWrites:0,iamKmsChanges:false,reads:[],archives:[],identities:[],builds:[],fullQa09Accepted:false};
const save=()=>writeFileSync(new URL('first-recovery-final.json',root),JSON.stringify(r,null,2)+'\n');save();
const aws=args=>{r.reads.push({operation:args.slice(0,2).join(':'),result:'RUNNING'});save();const v=JSON.parse(execFileSync('aws',[...args,'--profile','esgiot-infra','--region','ap-southeast-1','--output','json','--no-cli-pager','--cli-connect-timeout','5','--cli-read-timeout','10'],{encoding:'utf8',timeout:20000,maxBuffer:1048576,env:{...process.env,AWS_MAX_ATTEMPTS:'1'}}));r.reads.at(-1).result='PASS';save();return v;};
try{
 const identity=aws(['sts','get-caller-identity']);if(identity.Account!=='065986019555'||!identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'))throw Error('WRONG_IDENTITY');
 const db=JSON.parse(readFileSync(recovery.databaseBuilds.find(b=>b.action==='audit-empty').receipt));if(db.gate!=='PASS'||!db.result.empty||db.result.prefix!==parent.prefix||db.build.status!=='SUCCEEDED')throw Error('DATABASE_NOT_EMPTY');r.databaseReceipt=recovery.databaseBuilds.find(b=>b.action==='audit-empty').receipt;r.databaseSha256=sha(readFileSync(r.databaseReceipt));
 for(const username of [parent.identity.username,recovery.recoveryIdentity.username]){
  const v=aws(['cognito-idp','list-users','--user-pool-id','ap-southeast-1_hZMX8LpFo','--filter',`email = "${username}"`,'--limit','1','--no-paginate','--query','{count:length(Users),token:PaginationToken}']);r.identities.push({username,...v});save();if(v.count!==0||v.token)throw Error('IDENTITY_NOT_EMPTY');
 }
 for(const customer of parent.customers)for(const type of ['heartbeat','telemetry','ack','report']){
  const prefix=`raw/topic_type=${type}/customer_id=${customer.id}/`;const v=aws(['s3api','list-object-versions','--bucket','fdp-test-raw-065986019555','--prefix',prefix,'--max-keys','1','--no-paginate','--query','{versions:length(Versions || `[]`),markers:length(DeleteMarkers || `[]`),truncated:IsTruncated}']);r.archives.push({prefix,...v});save();if(v.versions||v.markers||v.truncated)throw Error('ARCHIVE_NOT_EMPTY');
 }
 const ids=[...parent.databaseBuilds,...child.builds,...recovery.databaseBuilds].map(b=>b.buildId).filter(Boolean);if(new Set(ids).size!==ids.length||ids.some(id=>!/^fdp-test-qa09-ten-device-fixtures:[a-f0-9-]{36}$/.test(id)))throw Error('EXACT_BUILD_LEDGER_REQUIRED');
 for(let i=0;i<ids.length;i+=5){const batch=ids.slice(i,i+5),v=aws(['codebuild','batch-get-builds','--ids',...batch,'--query','{builds:builds[].{id:id,status:buildStatus},missing:buildsNotFound}']);if(v.missing.length||v.builds.length!==batch.length||v.builds.some(b=>!batch.includes(b.id)||b.status!=='SUCCEEDED'))throw Error('KNOWN_BUILD_NOT_SUCCEEDED');r.builds.push(...v.builds);save();}
 r.gate='PASS_RECOVERED_OWN_EMPTY_UNKNOWN_RETAINED';
}catch(e){r.gate='FAIL';r.failureCode=/^[A-Z_]+$/.test(e.message)?e.message:'READ_FAILED_NO_MUTATION_RETRY';}
r.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({gate:r.gate,originalStartGate:r.originalStartGate}));process.exitCode=r.gate.startsWith('PASS_')?0:1;
