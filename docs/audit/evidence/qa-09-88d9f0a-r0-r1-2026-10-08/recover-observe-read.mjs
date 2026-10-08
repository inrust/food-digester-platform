// Recover only one existing capacity-readonly Build; never start/update a Build.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readVerifiedFixtureFrame} from '../../../../scripts/qa09-db-frame-wait.mjs';
const [source,out]=process.argv.slice(2);if(existsSync(out))throw Error('FRESH_RECOVERY_OUTPUT_REQUIRED');
const old=JSON.parse(readFileSync(source)),prep=JSON.parse(readFileSync(source+'.preparation.json'));
if(old.gate!=='RUNNING'||prep.plan.action!=='observe')throw Error('ONLY_EXISTING_READONLY_BUILD');
function aws(args,profile='esgiot-infra') {const q=spawnSync('aws',[...args,'--profile',profile,'--region','ap-southeast-1','--output','json','--no-cli-pager'],{encoding:'utf8',timeout:150000,maxBuffer:16*1024*1024,env:{...process.env,AWS_MAX_ATTEMPTS:'1'}});if(q.status!==0)throw Error('RECOVERY_CLI_READ_FAILED');return JSON.parse(q.stdout);}
const build=aws(['codebuild','batch-get-builds','--ids',old.build.id,'--query','builds[0].{id:id,status:buildStatus,phase:currentPhase,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,buildspec:source.buildspec,sourceType:source.type,logs:logs}']);
if(build.status!=='SUCCEEDED'||build.id!==old.build.id||build.buildspec!==prep.project.source.buildspec||build.sourceType!=='NO_SOURCE'||build.serviceRole!==prep.project.serviceRole||JSON.stringify(build.vpcConfig)!==JSON.stringify(prep.project.vpcConfig))throw Error('EXACT_CAPACITY_BUILD_NOT_VERIFIED');
const verified=await readVerifiedFixtureFrame(()=>aws(['logs','get-log-events','--log-group-name',build.logs.groupName,'--log-stream-name',build.logs.streamName,'--start-from-head'],'esgiot-readonly'),{buildId:build.id,sourceHash:prep.sourceHash,prefix:prep.plan.prefix,action:'observe'});
if(verified.frame.action!=='observe'||Object.keys(verified.frame.deleted??{}).length!==0)throw Error('READONLY_OBSERVE_REQUIRED');
delete build.buildspec;
const receipt={gate:'PASS',scope:'READ_RECOVERY_EXISTING_OBSERVE_BUILD_NO_RESTART',build,sourceHash:prep.sourceHash,buildspecHash:prep.buildspecHash,result:verified.frame,resultReadObservations:verified.observations,resultReadProfile:'esgiot-readonly',recoverySourceSha256:createHash('sha256').update(readFileSync(source)).digest('hex'),newBuilds:0,newFixtures:0};writeFileSync(out,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({gate:'PASS',buildId:build.id,writes:0,newBuilds:0}));
