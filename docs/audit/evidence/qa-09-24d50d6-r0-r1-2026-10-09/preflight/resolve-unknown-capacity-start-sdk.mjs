import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { verifyStartedBuild } from '../../../../../scripts/qa09-started-build-read.mjs';
import { decodeFixtureFrames } from '../../../../../scripts/qa09-db-log-frames.mjs';
import { safeOperationError } from '../../../../../scripts/qa09-operation-observation.mjs';
const [originalFile, output] = process.argv.slice(2);
if (!originalFile || !output || existsSync(output)) throw Error('FRESH_OUTPUT_REQUIRED');
const bytes = readFileSync(originalFile), original = JSON.parse(bytes), prepBytes = readFileSync(originalFile+'.preparation.json'), prep = JSON.parse(prepBytes);
if (original.gate!=='FAIL' || original.build || original.failure?.kind!=='START_OUTCOME_UNCONFIRMED' || prep.plan.action!=='capacity-readonly') throw Error('UNKNOWN_READ_ONLY_START_REQUIRED');
const hash = b => createHash('sha256').update(b).digest('hex');
const r = {gate:'RUNNING',scope:'EXACT_UNKNOWN_READ_ONLY_START_RESOLUTION_NO_RESTART',originalGate:'FAIL',originalReceiptSha256:hash(bytes),preparationSha256:hash(prepBytes),resolverSha256:hash(readFileSync(new URL(import.meta.url))),reads:[],writes:0,otherBuildDetailsPersisted:false};
const save = () => writeFileSync(output,JSON.stringify(r,null,2)+'\n'); save();
const exported = spawnSync('aws',['configure','export-credentials','--profile','esgiot-readonly','--format','process'],{encoding:'utf8',timeout:30000});
if(exported.status!==0) throw Error('READONLY_CREDENTIALS_UNAVAILABLE');
const c = JSON.parse(exported.stdout), config = {region:'ap-southeast-1',maxAttempts:1,credentials:{accessKeyId:c.AccessKeyId,secretAccessKey:c.SecretAccessKey,sessionToken:c.SessionToken}};
const cb = new CodeBuildClient(config), logs = new CloudWatchLogsClient(config);
async function read(name,client,command) {
  for(let attempt=1;attempt<=3;attempt++) {
    const row={operation:name,attempt,startedAt:new Date().toISOString(),result:'RUNNING'};r.reads.push(row);save();const started=performance.now();
    try {const v=await client.send(command,{abortSignal:AbortSignal.timeout(45000)});row.result='PASS';return v;}
    catch(e){row.result='FAIL';row.failure=safeOperationError(e);if(attempt===3 || !['AbortError','TimeoutError','NetworkingError'].includes(e.name) && !['ETIMEDOUT','ECONNRESET','ENOTFOUND','EAI_AGAIN'].includes(e.code))throw e;}
    finally {row.durationMs=Math.round(performance.now()-started);row.finishedAt=new Date().toISOString();save();}
  }
}
try {
  const ids=(await read('ListBuildsForProject',cb,new ListBuildsForProjectCommand({projectName:prep.project.name,sortOrder:'DESCENDING'}))).ids.slice(0,20);
  const response=await read('BatchGetBuilds',cb,new BatchGetBuildsCommand({ids}));
  const all=response.builds.map(b=>({id:b.id,status:b.buildStatus,phase:b.currentPhase,startTime:b.startTime?.toISOString(),endTime:b.endTime?.toISOString(),serviceRole:b.serviceRole,vpcConfig:b.vpcConfig,buildspec:b.source.buildspec,sourceType:b.source.type,environment:b.environment,logs:b.logs}));
  const matches=all.filter(b=>{try {verifyStartedBuild(b,prep,b.id);return true;}catch(e){if(e.message!=='FIXTURE_BUILD_BINDING_MISMATCH')throw e;return false;}});
  const started=Date.parse(original.operations.find(x=>x.operation==='start-build').startedAt);
  if(ids.length>=20 && Math.min(...all.map(b=>Date.parse(b.startTime)))>started-120000)throw Error('RECENT_WINDOW_INCOMPLETE');
  if(matches.length!==1 || Date.parse(matches[0].startTime)<started-120000 || Date.parse(matches[0].startTime)>Date.parse(original.finishedAt)+30000)throw Error('UNIQUE_EXACT_STARTED_BUILD_REQUIRED');
  const b=matches[0];r.buildId=b.id;r.scannedCount=ids.length;save();
  if(b.status!=='SUCCEEDED')throw Error('ORIGINAL_BUILD_NOT_SUCCESSFUL');
  const page=await read('GetLogEvents',logs,new GetLogEventsCommand({logGroupName:b.logs.groupName,logStreamName:b.logs.streamName,startFromHead:true}));
  const frames=decodeFixtureFrames(page.events),expected={buildId:b.id,sourceHash:prep.sourceHash,prefix:prep.plan.prefix,action:prep.plan.action};
  if(frames.length!==1 || frames[0].gate!=='PASS' || Object.entries(expected).some(([k,v])=>frames[0][k]!==v))throw Error('EXACT_RESULT_FRAME_REQUIRED');
  delete b.buildspec;delete b.environment;
  Object.assign(r,{gate:'PASS',build:b,result:frames[0]});
} catch(e){r.gate='FAIL';r.failure=safeOperationError(e);}
finally {cb.destroy();logs.destroy();r.finishedAt=new Date().toISOString();save();}
console.log(JSON.stringify({gate:r.gate,buildId:r.buildId,action:r.result?.action,writes:0}));process.exitCode=r.gate==='PASS'?0:1;
